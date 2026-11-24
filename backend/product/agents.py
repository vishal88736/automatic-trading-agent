"""PostgreSQL-backed paper agent commands, checkpoints, and due work."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID, uuid4, uuid5

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import Field, model_validator

from backend.models import Model
from backend.product.errors import ConflictError, NotFoundError
from backend.product.execution import (
    OrderRequest,
    PaperTerms,
    agent_cash_reserved,
    get_order,
    lock_account,
    positions,
    reservations,
    submit_order,
)
from backend.product.rules import Name, StrategyDraft
from backend.product.strategies import create_strategy, get_strategy
from backend.settings import get_settings


class AgentStartSettings(Model):
    request_key: UUID = Field(default_factory=uuid4)
    name: Name
    epoch: int = Field(ge=1)
    capital: Annotated[Decimal, Field(gt=0, le=100000, decimal_places=6)]
    interval_seconds: int = Field(default=60, ge=10, le=3600)
    max_drawdown: Annotated[Decimal, Field(gt=0, le=Decimal("0.10"))] = Decimal("0.10")
    max_daily_loss: Annotated[Decimal, Field(gt=0, le=Decimal("0.03"))] = Decimal("0.03")


class AgentStart(AgentStartSettings):
    report_id: UUID | None = None
    strategy_id: UUID | None = None
    strategy_version: int | None = Field(default=None, ge=1, le=2**31 - 1)

    @model_validator(mode="after")
    def select_validation_source(self):
        if self.report_id is not None:
            valid = self.strategy_id is None and self.strategy_version is None
        else:
            valid = self.strategy_id is not None and self.strategy_version is not None
        if not valid:
            raise ValueError("Choose a report or one saved strategy version")
        return self


class DraftAgentStart(AgentStartSettings):
    document: StrategyDraft


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
              a.last_candle, a.last_quote, a.next_review_at, v.document->'definition'->>'asset' AS asset,
              a.live_connection_id, a.live_budget, a.live_since, lc.label AS live_label,
              lc.exchange AS live_exchange, lc.environment AS live_environment,
              lc.status AS live_status, live.orders AS live_orders, live.spent AS live_spent,
              live.received AS live_received,
              totals.fills, totals.realized_pnl, totals.quantity AS open_quantity,
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
            LEFT JOIN live_connections lc
              ON lc.owner_id = a.owner_id AND lc.id = a.live_connection_id
            CROSS JOIN LATERAL (
                SELECT count(*) FILTER (WHERE status NOT IN ('SKIPPED', 'REJECTED')) AS orders,
                    coalesce(sum(quote_filled) FILTER (WHERE side = 'BUY'), 0) AS spent,
                    coalesce(sum(quote_filled) FILTER (WHERE side = 'SELL'), 0) AS received
                FROM live_orders WHERE owner_id = a.owner_id AND agent_id = a.id
            ) live
            WHERE a.owner_id = %s ORDER BY a.created_at DESC LIMIT 100
            """,
            (owner,),
        ).fetchall()


LeaderboardScope = Literal["active", "all"]


def leaderboard(
    db,
    viewer: UUID,
    scope: LeaderboardScope = "active",
    limit: int = 50,
    *,
    strategies: bool = False,
    offset: int = 0,
    share_id: str | None = None,
):
    """Rank agents from every account by return on their own allocation.

    Equity comes from the worker's marks, so a ranking never depends on a browser session.
    Owners are shown by their self-hosted display name, or by a short anonymous handle.
    """
    statuses = ("RUNNING", "PAUSED") if scope == "active" else ("RUNNING", "PAUSED", "STOPPED")
    with db.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            """
            SELECT a.id, a.owner_id = %s AS mine, a.name, a.status, a.stage, a.capital,
              a.created_at, v.document->>'name' AS strategy, a.live_connection_id IS NOT NULL AS live,
              v.document->'definition'->>'asset' AS asset,
              CASE WHEN %s THEN sha256(convert_to(v.strategy_id::text || ':' || v.version::text, 'UTF8')) END AS share_digest,
              CASE WHEN %s THEN v.document - 'description' END AS shared_document,
              coalesce(u.display_name, 'Trader ' || upper(left(a.owner_id::text, 4))) AS owner,
              totals.fills, totals.realized_pnl,
              coalesce(last.equity, a.capital + totals.delta) AS equity,
              last.observed_at AS marked_at, curve.max_drawdown, curve.samples
            FROM paper_agents a
            JOIN platform_strategy_versions v
              ON (v.owner_id, v.strategy_id, v.version) = (a.owner_id, a.strategy_id, a.strategy_version)
            LEFT JOIN platform_credentials u ON u.user_id = a.owner_id
            CROSS JOIN LATERAL (
                SELECT count(*) AS fills, coalesce(sum(l.realized_pnl), 0) AS realized_pnl,
                    coalesce(sum(l.amount), 0) AS delta
                FROM paper_orders o JOIN paper_ledger_entries l ON l.order_id = o.id
                WHERE o.owner_id = a.owner_id AND o.agent_id = a.id
            ) totals
            LEFT JOIN LATERAL (
                SELECT equity, observed_at FROM paper_agent_equity
                WHERE owner_id = a.owner_id AND agent_id = a.id
                ORDER BY observed_at DESC LIMIT 1
            ) last ON TRUE
            CROSS JOIN LATERAL (
                SELECT round(coalesce(max(1 - equity / nullif(peak, 0)), 0), 6) AS max_drawdown,
                    count(*) AS samples
                FROM (
                    SELECT equity, greatest(a.capital, max(equity) OVER (ORDER BY observed_at))
                        AS peak
                    FROM paper_agent_equity WHERE owner_id = a.owner_id AND agent_id = a.id
                ) marks
            ) curve
            JOIN platform_strategies s ON (s.owner_id, s.id) = (v.owner_id, v.strategy_id)
            WHERE a.status = ANY(%s)
              AND (NOT %s OR (s.archived_at IS NULL AND curve.samples > 0
                   AND totals.fills > 0 AND last.equity > a.capital))
              AND (%s::text IS NULL OR encode(sha256(convert_to(
                   v.strategy_id::text || ':' || v.version::text, 'UTF8')), 'hex') = %s)
            """,
            (
                viewer,
                strategies,
                share_id is not None,
                list(statuses),
                strategies,
                share_id,
                share_id,
            ),
        ).fetchall()
    for row in rows:
        row["return_pct"] = round((row["equity"] - row["capital"]) / row["capital"], 6)
        if not row["mine"]:
            row["id"] = None
    rows.sort(key=lambda row: (row["return_pct"], -row["max_drawdown"]), reverse=True)
    if strategies:
        versions = {}
        for row in rows:
            if row["return_pct"] > 0:
                versions.setdefault(row["share_digest"].hex(), row)
        rows = [
            {
                "share_id": digest,
                **{
                    key: row[key]
                    for key in ("strategy", "asset", "owner", "return_pct", "max_drawdown", "fills")
                },
                **({"document": row["shared_document"]} if share_id else {}),
            }
            for digest, row in versions.items()
        ]
    else:
        for row in rows:
            row.pop("share_digest")
            row.pop("shared_document")
    return [
        {"rank": index + 1, **row}
        for index, row in enumerate(rows[offset : offset + limit], start=offset)
    ]


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
            SELECT name, initial_report_id, epoch, capital, interval_seconds, max_drawdown, max_daily_loss,
                CASE WHEN initial_report_id IS NULL THEN strategy_id END,
                CASE WHEN initial_report_id IS NULL THEN strategy_version END
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
                request.strategy_id,
                request.strategy_version,
            ):
                raise ConflictError("Agent key already belongs to a different request")
            return request.request_key
        if stopped or account.epoch != request.epoch:
            raise ConflictError("Paper account cannot start agents in this state")
        if request.report_id is not None:
            strategy = db.execute(
                """
                SELECT b.strategy_id, b.strategy_version FROM platform_backtests b
                JOIN platform_strategies s
                  ON (s.owner_id, s.id) = (b.owner_id, b.strategy_id)
                WHERE b.owner_id = %s AND b.id = %s AND s.archived_at IS NULL
                """,
                (owner, request.report_id),
            ).fetchone()
        else:
            strategy = db.execute(
                """
                SELECT v.strategy_id, v.version FROM platform_strategy_versions v
                JOIN platform_strategies s
                  ON (s.owner_id, s.id) = (v.owner_id, v.strategy_id)
                WHERE v.owner_id = %s AND v.strategy_id = %s AND v.version = %s
                  AND s.archived_at IS NULL
                """,
                (owner, request.strategy_id, request.strategy_version),
            ).fetchone()
        if strategy is None:
            raise NotFoundError("Strategy or backtest is unavailable")
        _validate_allocation(db, owner, account.epoch, account.cash, request.capital)
        ident = request.request_key
        db.execute(
            """
            INSERT INTO paper_agents (id, owner_id, account_id, epoch, name, strategy_id,
                strategy_version, report_id, capital, max_drawdown, max_daily_loss, interval_seconds,
                initial_report_id, status, stage)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'RUNNING', 'VALIDATE')
            """,
            (
                ident,
                owner,
                account.id,
                account.epoch,
                request.name,
                strategy[0],
                strategy[1],
                request.report_id,
                request.capital,
                request.max_drawdown,
                request.max_daily_loss,
                request.interval_seconds,
                request.report_id,
            ),
        )
        event(
            db,
            owner,
            ident,
            "QUEUED",
            {
                "report_id": str(request.report_id) if request.report_id else None,
                "version": strategy[1],
            },
        )
        return ident


def start_draft_agent(db, owner: UUID, request: DraftAgentStart):
    """Persist version one and queue its agent together using the same start rules."""
    strategy_id = uuid5(owner, f"paper-agent-draft:{request.request_key}")
    with db.transaction():
        lock_account(db, owner)
        saved = get_strategy(db, owner, strategy_id, version=1)
        if saved is None:
            saved = create_strategy(db, owner, request.document, strategy_id=strategy_id)
        elif saved.document != request.document:
            raise ConflictError("Agent key already belongs to a different strategy draft")
        agent = start_agent(
            db,
            owner,
            AgentStart(
                **request.model_dump(exclude={"document", "request_key"}),
                request_key=uuid5(owner, f"paper-agent-from-draft:{request.request_key}"),
                strategy_id=saved.id,
                strategy_version=saved.version,
            ),
        )
        return agent, saved


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
    max_agents = get_settings().paper.max_agents
    if count >= max_agents:
        raise ConflictError(f"Account reached its limit of {max_agents} active paper agents")
    if booked + pending + capital > cash:
        raise ConflictError("Agent allocation exceeds the available paper capital")


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
            raise NotFoundError("Paper agent is unavailable")
        status, epoch, capital = row
        target = {"pause": "PAUSED", "resume": "RUNNING", "stop": "STOPPED"}[action]
        if target == status:
            return status
        if status == "STOPPED" or (status == "FAILED" and target != "STOPPED"):
            raise ConflictError("Paper agent has ended")
        if target == "RUNNING":
            if stopped or epoch != account.epoch:
                raise ConflictError("Paper account cannot resume agents in this state")
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
                heartbeat = clock_timestamp(),
                failures = a.failures + CASE WHEN due.recovered THEN 1 ELSE 0 END
            FROM due WHERE a.id = due.id RETURNING a.*, due.recovered
            """,
            (token, lease_seconds),
        ).fetchone()
        if row and row["recovered"]:
            if row["failures"] >= 5:
                event(
                    db,
                    row["owner_id"],
                    row["id"],
                    "FAILED",
                    {"reason": "Worker claim retry limit", "stage": row["stage"]},
                )
                checkpoint(
                    db,
                    row,
                    stage=row["stage"],
                    status="FAILED",
                    failures=row["failures"],
                    peak=row["peak_price"],
                )
                return None
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


def mark_agent(db, work, quantity, price, at):
    owner, agent = work["owner_id"], work["id"]
    (cash_delta,) = db.execute(
        """
        SELECT coalesce(sum(l.amount), 0)
        FROM paper_ledger_entries l JOIN paper_orders o ON o.id = l.order_id
        WHERE o.owner_id = %s AND o.agent_id = %s
        """,
        (owner, agent),
    ).fetchone()
    equity = work["capital"] + cash_delta + quantity * price
    peak, daily = db.execute(
        """
        SELECT max(equity), (
            SELECT equity FROM paper_agent_equity WHERE owner_id = %s AND agent_id = %s
                  AND observed_at < date_trunc('day', %s::timestamptz, 'UTC')
            ORDER BY observed_at DESC LIMIT 1
        ) FROM paper_agent_equity WHERE owner_id = %s AND agent_id = %s
        """,
        (owner, agent, at, owner, agent),
    ).fetchone()
    db.execute(
        "INSERT INTO paper_agent_equity VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
        (owner, agent, at, equity),
    )
    daily = work["capital"] if daily is None else daily
    high = max(peak or work["capital"], work["capital"])
    if equity <= daily * (1 - work["max_daily_loss"]):
        return equity, "AGENT_DAILY_LOSS"
    if equity <= high * (1 - work["max_drawdown"]):
        return equity, "AGENT_DRAWDOWN"
    return equity, None


def position_asset(db, owner, agent):
    row = db.execute(
        """
        SELECT v.document->'definition'->>'asset'
        FROM paper_agents a JOIN platform_strategy_versions v
          ON (v.owner_id, v.strategy_id, v.version) = (a.owner_id, a.strategy_id, a.strategy_version)
        WHERE a.owner_id = %s AND a.id = %s
        """,
        (owner, agent),
    ).fetchone()
    if row is None:
        raise NotFoundError("Paper agent is unavailable")
    return row[0]


def close_agent_position(db, owner, agent, request_key, epoch, quotes):
    with db.transaction():
        account, _ = lock_account(db, owner)
        row = db.execute(
            "SELECT status, epoch FROM paper_agents WHERE owner_id = %s AND id = %s FOR UPDATE",
            (owner, agent),
        ).fetchone()
        if row is None:
            raise NotFoundError("Paper agent is unavailable")
        previous = db.execute(
            "SELECT id, agent_id, epoch, request->>'side' FROM paper_orders WHERE owner_id = %s AND request_key = %s",
            (owner, request_key),
        ).fetchone()
        if previous:
            if previous[1:] != (agent, epoch, "SELL"):
                raise ConflictError("Order key already belongs to a different request")
            return get_order(db, owner, previous[0])
        if account.epoch != epoch or row[1] != epoch or row[0] == "RUNNING":
            raise ConflictError("Pause or stop the current-epoch agent before closing its position")
        asset = position_asset(db, owner, agent)
        held = positions(db, owner, account.epoch, actor_only=True, agent_id=agent).get(asset)
        if not held or held["quantity"] <= 0:
            raise ConflictError("This agent has no open position")
        order = submit_order(
            db,
            owner,
            OrderRequest(
                request_key=request_key,
                epoch=epoch,
                asset=asset,
                side="SELL",
                quantity=held["quantity"],
            ),
            quotes,
            PaperTerms(),
            agent_id=agent,
        )
        event(
            db,
            owner,
            agent,
            "MANUAL_CLOSE",
            {"order_id": str(order["id"]), "status": order["status"], "reason": order["reason"]},
        )
        return order
