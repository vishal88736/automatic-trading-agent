"""Transactional paper orders against the canonical owner/epoch ledger."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from typing import Annotated, Literal
from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import AwareDatetime, Field, model_validator

from aegis.risk.policy import CAPS as REVIEWED_TRADE_CAPS
from backend.models import Model, RiskConfig, now
from backend.paper_accounts import PaperAccount, get_account

Asset = Literal["BTC", "ETH", "SOL"]
Quantity = Annotated[Decimal, Field(gt=0, le=1000000, decimal_places=12)]
Price = Annotated[Decimal, Field(gt=0, le=100000000, decimal_places=12)]
USDT = Decimal("0.000001")
PX = Decimal("0.000000000001")
BPS = Decimal(10000)


class OrderRequest(Model):
    request_key: UUID
    epoch: int = Field(ge=1)
    asset: Asset
    side: Literal["BUY", "SELL"]
    quantity: Quantity
    limit_price: Price | None = None


class PaperQuote(Model):
    asset: Asset
    price: Price
    observed_at: AwareDatetime
    source: Literal["coinbase_exchange", "fixture"]


class PaperTerms(Model):
    fee_bps: int = Field(default=10, ge=0, le=100)
    slippage_bps: int = Field(default=10, ge=0, le=100)
    risk: RiskConfig = Field(default_factory=RiskConfig)

    @model_validator(mode="after")
    def costs_within_policy(self):
        if (
            self.fee_bps > self.risk.max_trading_fee_bps
            or self.slippage_bps > self.risk.max_slippage_bps
        ):
            raise ValueError("Execution costs exceed the risk policy")
        return self


def lock_account(db: Connection, owner: UUID) -> tuple[PaperAccount, bool]:
    row = db.execute(
        "SELECT emergency_stop FROM paper_accounts WHERE owner_id = %s FOR NO KEY UPDATE", (owner,)
    ).fetchone()
    account = get_account(db, owner) if row else None
    if account is None:
        raise ValueError("Open a paper account first")
    return account, row[0]


def positions(
    db: Connection, owner: UUID, epoch: int, *, actor_only=False, agent_id: UUID | None = None
) -> dict[str, dict]:
    with db.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            """
            SELECT l.asset, sum(l.quantity) AS quantity, sum(l.cost_delta) AS basis,
                   sum(l.realized_pnl) AS realized_pnl
            FROM paper_ledger_entries l JOIN paper_orders o ON o.id = l.order_id
            WHERE l.owner_id = %s AND l.epoch = %s
              AND (NOT %s OR o.agent_id IS NOT DISTINCT FROM %s)
            GROUP BY l.asset
            """,
            (owner, epoch, actor_only, agent_id),
        ).fetchall()
    return {row["asset"]: row for row in rows}


def reservations(
    db: Connection,
    owner: UUID,
    epoch: int,
    exclude: UUID | None = None,
    agent_id: UUID | None = None,
):
    rows = db.execute(
        """
        SELECT request->>'asset', sum(reserved_cash),
          coalesce(sum(reserved_quantity) FILTER (WHERE agent_id IS NOT DISTINCT FROM %s), 0)
        FROM paper_orders
        WHERE owner_id = %s AND epoch = %s AND status = 'OPEN' AND id IS DISTINCT FROM %s
        GROUP BY request->>'asset'
        """,
        (agent_id, owner, epoch, exclude),
    ).fetchall()
    return sum((cash for _, cash, _ in rows), Decimal(0)), {
        asset: quantity for asset, _, quantity in rows
    }


def agent_cash_reserved(db, owner, epoch, exclude=None):
    return db.execute(
        """
        SELECT coalesce(sum(greatest(0, capital + delta)), 0) FROM (
            SELECT a.capital, coalesce(sum(l.amount), 0) AS delta
            FROM paper_agents a LEFT JOIN paper_orders o ON o.agent_id = a.id
            LEFT JOIN paper_ledger_entries l ON l.order_id = o.id
            WHERE a.owner_id = %s AND a.epoch = %s AND a.status IN ('RUNNING', 'PAUSED')
                AND a.id IS DISTINCT FROM %s
            GROUP BY a.id
        ) AS allocations
        """,
        (owner, epoch, exclude),
    ).fetchone()[0]


def _fresh(quotes: dict[str, PaperQuote], asset: str, at: datetime, max_age: int):
    quote = quotes.get(asset)
    if quote is not None and quote.asset == asset:
        age = at - quote.observed_at
        if timedelta(0) <= age <= timedelta(seconds=max_age):
            return quote


def _cost(quantity: Decimal, price: Decimal, terms: PaperTerms) -> tuple[Decimal, Decimal]:
    gross = (quantity * price).quantize(USDT, rounding=ROUND_DOWN)
    fee = (gross * terms.fee_bps / BPS).quantize(USDT, rounding=ROUND_UP)
    return gross, fee


def _finish(db: Connection, order_id: UUID, status: str, reason: str | None, at: datetime):
    db.execute(
        """
        UPDATE paper_orders SET status = %s, reason = %s, reserved_cash = 0,
          reserved_quantity = 0, updated_at = %s WHERE id = %s
        """,
        (status, reason, at, order_id),
    )


def _buy_risk(db, owner, account, asset, gross, fee, held, quotes, at, terms):
    risk = terms.risk
    marks = {}
    for symbol, position in held.items():
        if position["quantity"] <= 0:
            continue
        quote = _fresh(quotes, symbol, at, risk.max_quote_age_seconds)
        if quote is None:
            return "STALE_PORTFOLIO"
        marks[symbol] = position["quantity"] * quote.price
    exposure = sum(marks.values(), Decimal(0))
    equity = account.cash + exposure
    if gross > risk.max_trade_notional or gross + fee > equity * risk.max_equity_per_trade:
        return "ORDER_CAP"
    if (
        (asset not in marks and len(marks) >= risk.max_positions)
        or marks.get(asset, 0) + gross > equity * risk.max_asset_exposure
        or exposure + gross > equity * risk.max_aggregate_exposure
    ):
        return "EXPOSURE_CAP"
    midnight = at.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    peak, reference = db.execute(
        """
        SELECT max(equity), (
            SELECT equity FROM paper_equity_snapshots
            WHERE owner_id = %s AND epoch = %s AND observed_at < %s
            ORDER BY observed_at DESC LIMIT 1
        ) FROM paper_equity_snapshots WHERE owner_id = %s AND epoch = %s
        """,
        (owner, account.epoch, midnight, owner, account.epoch),
    ).fetchone()
    initial = db.execute(
        "SELECT amount FROM paper_ledger_entries WHERE owner_id = %s AND epoch = %s AND kind = 'OPENING_CREDIT'",
        (owner, account.epoch),
    ).fetchone()[0]
    db.execute(
        "INSERT INTO paper_equity_snapshots VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
        (owner, account.id, account.epoch, at, equity),
    )
    peak = max(peak or initial, initial)
    reference = reference if reference is not None else initial
    if equity <= reference * (1 - risk.max_daily_loss):
        return "DAILY_LOSS"
    if equity <= peak * (1 - risk.max_drawdown):
        return "DRAWDOWN"
    recent_hour = at - timedelta(hours=1)
    cooldown = timedelta(seconds=risk.cooldown_seconds)
    last, hourly, daily = db.execute(
        """
        SELECT max(o.updated_at), count(*) FILTER (WHERE o.updated_at > %s),
            count(*) FILTER (WHERE o.updated_at >= %s)
        FROM paper_orders o
        WHERE o.owner_id = %s AND o.epoch = %s AND o.status = 'FILLED'
            AND o.updated_at >= %s
        """,
        (recent_hour, midnight, owner, account.epoch, min(recent_hour, midnight, at - cooldown)),
    ).fetchone()
    if (
        (last and at - last < cooldown)
        or hourly >= REVIEWED_TRADE_CAPS["max_trades_per_hour"]
        or daily >= REVIEWED_TRADE_CAPS["max_trades_per_day"]
    ):
        return "FREQUENCY"
    return None


def get_order(db: Connection, owner: UUID, order_id: UUID) -> dict | None:
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            """
            SELECT o.id, o.epoch, o.agent_id, o.request, o.status, o.reason, o.reserved_cash,
                   o.reserved_quantity, o.created_at, o.updated_at, l.price AS fill_price,
                   l.amount AS cash_delta, l.fee, l.realized_pnl, l.market_at, l.market_source
            FROM paper_orders o LEFT JOIN paper_ledger_entries l ON l.order_id = o.id
            WHERE o.owner_id = %s AND o.id = %s
            """,
            (owner, order_id),
        ).fetchone()


def _evaluate(
    db, owner, account, stopped, order_id, request, quotes, terms, at, *, pending, agent_id=None
):
    if stopped:
        _finish(db, order_id, "REJECTED", "EMERGENCY_STOP", at)
        return
    quote = _fresh(quotes, request.asset, at, terms.risk.max_quote_age_seconds)
    if quote is None:
        if not pending:
            _finish(db, order_id, "REJECTED", "STALE_QUOTE", at)
        return
    buy = request.side == "BUY"
    slip = Decimal(terms.slippage_bps) / BPS
    price = (quote.price * (1 + slip if buy else 1 - slip)).quantize(
        PX, rounding=ROUND_UP if buy else ROUND_DOWN
    )
    limit = request.limit_price
    crosses = limit is None or (price <= limit if buy else price >= limit)
    if pending and not crosses:
        return
    gross, fee = _cost(request.quantity, price if crosses else limit, terms)
    held = positions(db, owner, account.epoch)
    actor_positions = positions(db, owner, account.epoch, actor_only=True, agent_id=agent_id)
    position = actor_positions.get(request.asset, {"quantity": Decimal(0), "basis": Decimal(0)})
    reserved_cash, reserved_quantity = reservations(db, owner, account.epoch, order_id, agent_id)
    reason = None
    if gross <= fee:
        reason = "ORDER_TOO_SMALL"
    elif buy:
        if gross + fee > account.cash - reserved_cash - agent_cash_reserved(
            db, owner, account.epoch, agent_id
        ):
            reason = "INSUFFICIENT_CASH"
        else:
            reason = _buy_risk(
                db, owner, account, request.asset, gross, fee, held, quotes, at, terms
            )
    elif request.quantity > position["quantity"] - reserved_quantity.get(request.asset, 0):
        reason = "INSUFFICIENT_ASSET"
    if reason:
        _finish(db, order_id, "REJECTED", reason, at)
        return
    if not crosses:
        db.execute(
            "UPDATE paper_orders SET reserved_cash = %s, reserved_quantity = %s WHERE id = %s",
            (gross + fee if buy else 0, 0 if buy else request.quantity, order_id),
        )
        return

    if buy and agent_id is not None:
        capital, cash_delta = db.execute(
            """
            SELECT a.capital, coalesce(sum(l.amount), 0)
            FROM paper_agents a LEFT JOIN paper_orders o ON o.agent_id = a.id
            LEFT JOIN paper_ledger_entries l ON l.order_id = o.id
            WHERE a.owner_id = %s AND a.id = %s AND a.epoch = %s AND a.status = 'RUNNING'
            GROUP BY a.id
            """,
            (owner, agent_id, account.epoch),
        ).fetchone() or (Decimal(0), Decimal(0))
        if gross + fee > min(capital, capital + cash_delta) or (
            position["quantity"] * quote.price + gross > capital
        ):
            _finish(db, order_id, "REJECTED", "AGENT_CAPITAL", at)
            return
    quantity = request.quantity if buy else -request.quantity
    cash_delta = -(gross + fee) if buy else gross - fee
    if buy:
        cost_delta, realized = -cash_delta, 0
    else:
        cost_delta = -(position["basis"] * request.quantity / position["quantity"]).quantize(
            USDT, rounding=ROUND_DOWN
        )
        realized = cash_delta + cost_delta
    db.execute(
        """
        INSERT INTO paper_ledger_entries
          (owner_id, account_id, epoch, kind, amount, order_id, asset, quantity, price,
           fee, cost_delta, realized_pnl, market_at, market_source, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            owner,
            account.id,
            account.epoch,
            request.side,
            cash_delta,
            order_id,
            request.asset,
            quantity,
            price,
            fee,
            cost_delta,
            realized,
            quote.observed_at,
            quote.source,
            at,
        ),
    )
    _finish(db, order_id, "FILLED", None, at)


def submit_order(
    db, owner: UUID, request: OrderRequest, quotes, terms: PaperTerms, *, clock=now, agent_id=None
):
    with db.transaction():
        account, stopped = lock_account(db, owner)
        existing = db.execute(
            "SELECT id, request, agent_id FROM paper_orders WHERE owner_id = %s AND request_key = %s",
            (owner, request.request_key),
        ).fetchone()
        if existing:
            if OrderRequest.model_validate(existing[1]) != request or existing[2] != agent_id:
                raise ValueError("Order key already belongs to a different request")
            return get_order(db, owner, existing[0])
        if agent_id is not None and request.limit_price is not None:
            raise ValueError("Autonomous orders use market execution")
        if request.epoch != account.epoch:
            raise ValueError("Paper account epoch changed")
        at, order = clock(), uuid4()
        db.execute(
            """
            INSERT INTO paper_orders (id, owner_id, account_id, epoch, request_key, request,
              status, created_at, updated_at, agent_id)
            VALUES (%s, %s, %s, %s, %s, %s, 'OPEN', %s, %s, %s)
            """,
            (
                order,
                owner,
                account.id,
                account.epoch,
                request.request_key,
                Jsonb(request.model_dump(mode="json")),
                at,
                at,
                agent_id,
            ),
        )
        _evaluate(
            db,
            owner,
            account,
            stopped,
            order,
            request,
            quotes,
            terms,
            at,
            pending=False,
            agent_id=agent_id,
        )
        return get_order(db, owner, order)


def process_limit(db, owner: UUID, order_id: UUID, quotes, terms: PaperTerms, *, clock=now):
    with db.transaction():
        account, stopped = lock_account(db, owner)
        order = get_order(db, owner, order_id)
        if order is None:
            return None
        if order["status"] == "OPEN" and order["epoch"] == account.epoch:
            request = OrderRequest.model_validate(order["request"])
            _evaluate(
                db, owner, account, stopped, order_id, request, quotes, terms, clock(), pending=True
            )
        return get_order(db, owner, order_id)


def cancel_order(db, owner: UUID, order_id: UUID):
    with db.transaction():
        lock_account(db, owner)
        order = get_order(db, owner, order_id)
        if order and order["status"] == "OPEN":
            _finish(db, order_id, "CANCELLED", "USER_CANCELLED", now())
            return get_order(db, owner, order_id)
        return order


def set_emergency(db, owner: UUID, enabled: bool) -> bool:
    with db.transaction():
        account, _ = lock_account(db, owner)
        db.execute(
            "UPDATE paper_accounts SET emergency_stop = %s WHERE owner_id = %s", (enabled, owner)
        )
        if enabled:
            _cancel_open(db, owner, account.epoch, "EMERGENCY_STOP")
            _halt_agents(db, owner, account.epoch, "PAUSED", "Emergency stop")
    return enabled


def _halt_agents(db, owner, epoch, status, reason):
    db.execute(
        """
        WITH changed AS (
            UPDATE paper_agents SET status = %s, lease_token = NULL, lease_until = NULL
            WHERE owner_id = %s AND epoch = %s AND status IN ('RUNNING', 'PAUSED')
            RETURNING owner_id, id
        )
        INSERT INTO paper_agent_events (owner_id, agent_id, kind, detail)
        SELECT owner_id, id, %s, jsonb_build_object('reason', %s::text) FROM changed
        """,
        (status, owner, epoch, status, reason),
    )


def _cancel_open(db, owner, epoch, reason):
    db.execute(
        """
        UPDATE paper_orders SET status = 'CANCELLED', reason = %s, reserved_cash = 0,
          reserved_quantity = 0, updated_at = %s
        WHERE owner_id = %s AND epoch = %s AND status = 'OPEN'
        """,
        (reason, now(), owner, epoch),
    )


def reset_account(db, owner: UUID, expected_epoch: int, opening_credit: Decimal) -> PaperAccount:
    with db.transaction():
        account, _ = lock_account(db, owner)
        if account.epoch != expected_epoch:
            raise ValueError("Paper account epoch changed")
        _cancel_open(db, owner, account.epoch, "ACCOUNT_RESET")
        _halt_agents(db, owner, account.epoch, "STOPPED", "Account reset")
        db.execute(
            "UPDATE paper_account_epochs SET closed_at = now() WHERE owner_id = %s AND epoch = %s",
            (owner, expected_epoch),
        )
        db.execute(
            "INSERT INTO paper_account_epochs (owner_id, account_id, epoch) VALUES (%s, %s, %s)",
            (owner, account.id, expected_epoch + 1),
        )
        db.execute(
            """
            INSERT INTO paper_ledger_entries (owner_id, account_id, epoch, kind, amount)
            VALUES (%s, %s, %s, 'OPENING_CREDIT', %s)
            """,
            (owner, account.id, expected_epoch + 1, opening_credit),
        )
        return get_account(db, owner)


def portfolio(db, owner: UUID, quotes: dict[str, PaperQuote], *, clock=now, max_age=20) -> dict:
    """Return one consistent account valuation, with unknown marks left unavailable."""
    with db.transaction():
        account, stopped = lock_account(db, owner)
        at = clock()
        held = positions(db, owner, account.epoch)
        reserved, _ = reservations(db, owner, account.epoch)
        holdings = []
        total_value = Decimal(0)
        total_unrealized = Decimal(0)
        complete = True
        for asset, row in sorted(held.items()):
            if row["quantity"] == 0:
                continue
            quote = _fresh(quotes, asset, at, max_age)
            mark = row["quantity"] * quote.price if quote else None
            unrealized = mark - row["basis"] if mark is not None else None
            holdings.append(
                {
                    **row,
                    "mark": mark,
                    "unrealized_pnl": unrealized,
                    "market_at": quote.observed_at if quote else None,
                }
            )
            if mark is None:
                complete = False
            else:
                total_value += mark
                total_unrealized += unrealized
        equity = account.cash + total_value if complete else None
        if equity is not None:
            db.execute(
                """
                INSERT INTO paper_equity_snapshots VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (owner, account.id, account.epoch, at, equity),
            )
        peak, previous = db.execute(
            """
            SELECT max(equity), (
                SELECT equity FROM paper_equity_snapshots
                WHERE owner_id = %s AND epoch = %s AND observed_at < date_trunc('day', %s::timestamptz, 'UTC')
                ORDER BY observed_at DESC LIMIT 1
            ) FROM paper_equity_snapshots WHERE owner_id = %s AND epoch = %s
            """,
            (owner, account.epoch, at, owner, account.epoch),
        ).fetchone()
        opening = db.execute(
            "SELECT amount FROM paper_ledger_entries WHERE owner_id = %s AND epoch = %s AND kind = 'OPENING_CREDIT'",
            (owner, account.epoch),
        ).fetchone()[0]
        peak = max(peak or opening, opening)
        history = db.execute(
            """
            SELECT observed_at, equity FROM paper_equity_snapshots
            WHERE owner_id = %s AND epoch = %s ORDER BY observed_at DESC LIMIT 200
            """,
            (owner, account.epoch),
        ).fetchall()
        for holding in holdings:
            holding["allocation"] = holding["mark"] / equity if equity and complete else None
        return {
            "epoch": account.epoch,
            "currency": account.currency,
            "cash": account.cash,
            "available_cash": account.cash
            - reserved
            - agent_cash_reserved(db, owner, account.epoch),
            "equity": equity,
            "holdings": holdings,
            "realized_pnl": sum((row["realized_pnl"] for row in held.values()), Decimal(0)),
            "unrealized_pnl": total_unrealized if complete else None,
            "daily_pnl": equity - (previous if previous is not None else opening)
            if complete
            else None,
            "drawdown": max(Decimal(0), (peak - equity) / peak) if complete else None,
            "emergency_stop": stopped,
            "history": [{"at": t, "equity": value} for t, value in reversed(history)],
        }


def order_history(db, owner: UUID, *, epoch: int | None = None, limit=50) -> list[dict]:
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            """
            SELECT o.id, o.epoch, o.agent_id, o.request, o.status, o.reason, o.reserved_cash,
                   o.reserved_quantity, o.created_at, o.updated_at, l.price AS fill_price,
                   l.amount AS cash_delta, l.fee, l.realized_pnl, l.market_at, l.market_source
            FROM paper_orders o LEFT JOIN paper_ledger_entries l ON l.order_id = o.id
            WHERE o.owner_id = %s AND (%s::bigint IS NULL OR o.epoch = %s)
            ORDER BY o.created_at DESC, o.id DESC LIMIT %s
            """,
            (owner, epoch, epoch, limit),
        ).fetchall()
