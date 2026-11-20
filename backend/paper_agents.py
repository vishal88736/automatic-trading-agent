"""PostgreSQL-backed paper agent commands, checkpoints, and due work."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID, uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import Field

from backend.models import Model
from backend.paper_execution import agent_cash_reserved, lock_account, reservations
from backend.strategy_rules import Name


class AgentStart(Model):
    request_key: UUID = Field(default_factory=uuid4)
    name: Name
    report_id: UUID
    epoch: int = Field(ge=1)
    capital: Annotated[Decimal, Field(gt=0, le=100000, decimal_places=6)]
    interval_seconds: int = Field(default=60, ge=10, le=3600)
    max_drawdown: Annotated[Decimal, Field(gt=0, le=Decimal("0.10"))] = Decimal("0.10")
    max_daily_loss: Annotated[Decimal, Field(gt=0, le=Decimal("0.03"))] = Decimal("0.03")


class AgentCommand(Model):
    action: Literal["pause", "resume", "stop"]


def event(db, owner, agent, kind, detail):
    db.execute(
        "INSERT INTO paper_agent_events (owner_id, agent_id, kind, detail) VALUES (%s, %s, %s, %s)",
        (owner, agent, kind, Jsonb(detail)),
    )


def list_agents(db, owner: UUID):
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            """
            SELECT a.id, a.name, a.status, a.stage, a.heartbeat, a.next_run, a.capital, a.failures,
              a.strategy_id, a.strategy_version, a.report_id, a.epoch, a.interval_seconds,
              a.last_candle, a.last_quote, v.document->'definition'->>'asset' AS asset,
              totals.fills, totals.realized_pnl,
              CASE WHEN totals.quantity = 0 THEN 0
                   WHEN a.last_quote >= now() - make_interval(secs => a.interval_seconds * 2 + 20)
                   THEN totals.quantity * mark.price - totals.basis END AS unrealized_pnl,
              CASE WHEN totals.quantity = 0 THEN a.capital + totals.delta
                   WHEN a.last_quote >= now() - make_interval(secs => a.interval_seconds * 2 + 20)
                   THEN a.capital + totals.delta + totals.quantity * mark.price END AS value,
              (a.status = 'RUNNING' AND (
                    (a.lease_until IS NOT NULL AND a.lease_until <= now())
                    OR (a.lease_until IS NULL AND a.next_run < now() - interval '30 seconds')
              )) AS worker_overdue
            FROM paper_agents a JOIN platform_strategy_versions v
              ON (v.owner_id, v.strategy_id, v.version) = (a.owner_id, a.strategy_id, a.strategy_version)
            CROSS JOIN LATERAL (
                SELECT count(*) AS fills, coalesce(sum(l.realized_pnl), 0) AS realized_pnl,
                    coalesce(sum(l.quantity), 0) AS quantity, coalesce(sum(l.cost_delta), 0) AS basis,
                    coalesce(sum(l.amount), 0) AS delta
                FROM paper_orders o JOIN paper_ledger_entries l ON l.order_id = o.id
                WHERE o.owner_id = a.owner_id AND o.agent_id = a.id
            ) totals
            LEFT JOIN LATERAL (
                SELECT (detail->>'price')::numeric AS price FROM paper_agent_events
                WHERE owner_id = a.owner_id AND agent_id = a.id AND kind = 'DECISION'
                ORDER BY seq DESC LIMIT 1
            ) mark ON TRUE
            WHERE a.owner_id = %s ORDER BY a.created_at DESC LIMIT 100
            """,
            (owner,),
        ).fetchall()


def timeline(db, owner: UUID, agent: UUID, after: int = 0):
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            """
            SELECT seq, occurred_at, kind, detail FROM paper_agent_events
            WHERE owner_id = %s AND agent_id = %s AND seq > %s
            ORDER BY seq DESC LIMIT 100
            """,
            (owner, agent, after),
        ).fetchall()


def start_agent(db, owner: UUID, request: AgentStart):
    with db.transaction():
        account, stopped = lock_account(db, owner)
        previous = db.execute(
            """
            SELECT name, report_id, epoch, capital, interval_seconds, max_drawdown, max_daily_loss
            FROM paper_agents WHERE owner_id = %s AND id = %s
            """,
            (owner, request.request_key),
        ).fetchone()
        if previous:
            if previous != (
                request.name,
                request.report_id,
                request.epoch,
                request.capital,
                request.interval_seconds,
                request.max_drawdown,
                request.max_daily_loss,
            ):
                raise ValueError("Agent key already belongs to a different request")
            return request.request_key
        if stopped or account.epoch != request.epoch:
            raise ValueError("Paper account cannot start agents in this state")
        report = db.execute(
            """
            SELECT b.strategy_id, b.strategy_version FROM platform_backtests b
            JOIN platform_strategies s
              ON (s.owner_id, s.id) = (b.owner_id, b.strategy_id)
            WHERE b.owner_id = %s AND b.id = %s AND s.archived_at IS NULL
            """,
            (owner, request.report_id),
        ).fetchone()
        if report is None:
            raise LookupError("Backtest is unavailable")
        _validate_allocation(db, owner, account.epoch, account.cash, request.capital)
        ident = request.request_key
        db.execute(
            """
            INSERT INTO paper_agents (id, owner_id, account_id, epoch, name, strategy_id,
                strategy_version, report_id, capital, max_drawdown, max_daily_loss, interval_seconds,
                status, stage)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'RUNNING', 'VALIDATE')
            """,
            (
                ident,
                owner,
                account.id,
                account.epoch,
                request.name,
                report[0],
                report[1],
                request.report_id,
                request.capital,
                request.max_drawdown,
                request.max_daily_loss,
                request.interval_seconds,
            ),
        )
        event(
            db, owner, ident, "QUEUED", {"report_id": str(request.report_id), "version": report[1]}
        )
        return ident


def _validate_allocation(db, owner, epoch, cash, capital, exclude=None):
    (count,) = db.execute(
        """
        SELECT count(*) FROM paper_agents
        WHERE owner_id = %s AND epoch = %s AND status IN ('RUNNING', 'PAUSED')
            AND id IS DISTINCT FROM %s
        """,
        (owner, epoch, exclude),
    ).fetchone()
    booked = agent_cash_reserved(db, owner, epoch, exclude)
    pending, _ = reservations(db, owner, epoch)
    if exclude is not None:
        (delta,) = db.execute(
            """
            SELECT coalesce(sum(l.amount), 0) FROM paper_ledger_entries l
            JOIN paper_orders o ON o.id = l.order_id
            WHERE o.owner_id = %s AND o.agent_id = %s
            """,
            (owner, exclude),
        ).fetchone()
        capital = max(Decimal(0), capital + delta)
    if count >= 10 or booked + pending + capital > cash:
        raise ValueError("Agent allocation exceeds the available paper capital")


def control_agent(db, owner: UUID, agent: UUID, action: str):
    with db.transaction():
        account, stopped = lock_account(db, owner)
        row = db.execute(
            """
            SELECT status, epoch, capital FROM paper_agents
            WHERE owner_id = %s AND id = %s FOR UPDATE
            """,
            (owner, agent),
        ).fetchone()
        if row is None:
            raise LookupError("Paper agent is unavailable")
        status, epoch, capital = row
        target = {"pause": "PAUSED", "resume": "RUNNING", "stop": "STOPPED"}[action]
        if target == status:
            return status
        if status == "STOPPED" or (status == "FAILED" and target != "STOPPED"):
            raise ValueError("Paper agent has ended")
        if target == "RUNNING":
            if stopped or epoch != account.epoch:
                raise ValueError("Paper account cannot resume agents in this state")
            _validate_allocation(db, owner, account.epoch, account.cash, capital, agent)
        db.execute(
            """
            UPDATE paper_agents SET status = %s, lease_token = NULL, lease_until = NULL,
                next_run = now(), failures = 0 WHERE id = %s
            """,
            (target, agent),
        )
        event(db, owner, agent, target, {"action": action})
        return target


def claim_agent(db, lease_seconds=60):
    token = uuid4()
    with db.transaction(), db.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            """
            WITH due AS (
                SELECT id, lease_token IS NOT NULL AS recovered FROM paper_agents
                WHERE status = 'RUNNING' AND next_run <= clock_timestamp()
                  AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                ORDER BY next_run, id FOR UPDATE SKIP LOCKED LIMIT 1
            )
            UPDATE paper_agents a SET lease_token = %s,
                lease_until = clock_timestamp() + make_interval(secs => %s),
                heartbeat = clock_timestamp()
            FROM due WHERE a.id = due.id RETURNING a.*, due.recovered
            """,
            (token, lease_seconds),
        ).fetchone()
        if row and row["recovered"]:
            event(db, row["owner_id"], row["id"], "RECOVERED", {"stage": row["stage"]})
        return row


def fence(db, work):
    return (
        db.execute(
            """
        SELECT id FROM paper_agents WHERE id = %s AND status = 'RUNNING' AND lease_token = %s
            AND lease_until > clock_timestamp() FOR UPDATE
        """,
            (work["id"], work["lease_token"]),
        ).fetchone()
        is not None
    )


def checkpoint(
    db,
    work,
    *,
    stage="MONITOR",
    status="RUNNING",
    failures=0,
    delay=None,
    candle=None,
    quote=None,
    peak=None,
):
    db.execute(
        """
        UPDATE paper_agents SET stage = %s, status = %s, failures = %s,
          next_run = clock_timestamp() + make_interval(secs => %s), lease_token = NULL,
          lease_until = NULL, heartbeat = clock_timestamp(),
          last_candle = coalesce(%s, last_candle), last_quote = coalesce(%s, last_quote), peak_price = %s
        WHERE id = %s
        """,
        (
            stage,
            status,
            failures,
            delay if delay is not None else work["interval_seconds"],
            candle,
            quote,
            peak,
            work["id"],
        ),
    )
