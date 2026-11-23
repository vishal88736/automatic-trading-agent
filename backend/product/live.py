"""Live trading on a user's own exchange account, manually or through a promoted agent.

Krono stores an encrypted, trade-only API key, checks its permissions before saving it, and
places spot market orders. Every order row is written before the exchange call and keyed by
a client order ID, so a retry or crash can never submit twice. Funds never leave the user's
exchange account; live keys that can withdraw are rejected.

A promoted paper agent keeps trading on paper exactly as before. Each new paper fill is then
mirrored to the linked exchange through an outbox (paper fills without a live order), scaled
from the agent's paper capital to its live budget.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from datetime import timedelta
from decimal import ROUND_DOWN, Decimal
from typing import Annotated, Literal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import Field, StringConstraints

from backend.product.errors import LiveRejected
from backend.models import Model
from backend.product.credentials import CredentialVault
from backend.product.exchanges import (
    Environment,
    Exchange,
    ExchangeClient,
    ExchangeError,
    client_order_id,
    create_client,
)
from backend.product.price_hub import ASSETS
from backend.product.spot_markets import Asset

ClientFactory = Callable[[Exchange, Environment, dict], ExchangeClient]
STABLECOINS = {"USDT", "USDC", "FDUSD"}
MIN_ORDER_USDT = Decimal("5")
KeyText = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9-]{16,128}$")
]
Usdt = Annotated[Decimal, Field(gt=0, le=100000, decimal_places=2)]
MIRROR_NAMESPACE = uuid5(NAMESPACE_URL, "https://krono.local/live-mirror")


def promotion_days() -> int:
    return int(os.environ.get("KRONO_LIVE_PROMOTION_DAYS", "7"))


class LinkRequest(Model):
    exchange: Exchange = "binance"
    environment: Environment = "testnet"
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    api_key: KeyText
    api_secret: KeyText
    api_passphrase: Annotated[str, StringConstraints(max_length=64)] = ""
    max_order_usdt: Usdt = Decimal("100")


class LiveOrderRequest(Model):
    request_key: UUID
    asset: Asset
    side: Literal["BUY", "SELL"]
    quote_amount: Usdt
    acknowledge_live: bool = False


class LiveCommand(Model):
    action: Literal["pause", "resume"]


class Promotion(Model):
    connection_id: UUID
    budget_usdt: Usdt
    acknowledge_live: bool = False


class Demotion(Model):
    close_position: bool = False


def default_client(exchange: Exchange, environment: Environment, credentials: dict):
    return create_client(exchange, environment, credentials)


def safe_message(message: str) -> str:
    # Exchange errors can echo request fragments; never return anything key-shaped.
    return re.sub(r"[A-Za-z0-9]{32,}", "[redacted]", message)[:300]


# ---------------------------------------------------------------- connections
_PUBLIC = (
    "id",
    "exchange",
    "environment",
    "label",
    "key_hint",
    "permissions",
    "max_order_usdt",
    "status",
    "verified_at",
    "created_at",
)


def _public(row: dict) -> dict:
    return {key: row[key] for key in _PUBLIC}


def link_connection(
    db, owner: UUID, request: LinkRequest, vault: CredentialVault, factory: ClientFactory
) -> dict:
    credentials = {
        "api_key": request.api_key,
        "api_secret": request.api_secret,
        "api_passphrase": request.api_passphrase,
    }
    client = factory(request.exchange, request.environment, credentials)
    try:
        try:
            permissions = client.verify()
        except ExchangeError as exc:
            raise LiveRejected(
                f"The exchange rejected the key: {safe_message(exc.message)}"
            ) from None
    finally:
        client.close()
    connection = uuid4()
    nonce, ciphertext = vault.seal(owner, connection, credentials)
    with db.transaction():
        db.execute(
            "INSERT INTO platform_users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING", (owner,)
        )
        with db.cursor(row_factory=dict_row) as cursor:
            row = cursor.execute(
                """
                INSERT INTO live_connections (id, owner_id, exchange, environment, label, key_hint,
                    nonce, ciphertext, permissions, max_order_usdt, status, verified_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'ACTIVE', now())
                RETURNING *
                """,
                (
                    connection,
                    owner,
                    request.exchange,
                    request.environment,
                    request.label,
                    "…" + request.api_key[-4:],
                    nonce,
                    ciphertext,
                    Jsonb(permissions),
                    request.max_order_usdt,
                ),
            ).fetchone()
    return _public(row)


def list_connections(db, owner: UUID) -> list[dict]:
    with db.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            """
            SELECT * FROM live_connections WHERE owner_id = %s AND status <> 'REVOKED'
            ORDER BY created_at DESC
            """,
            (owner,),
        ).fetchall()
    return [_public(row) for row in rows]


def _load(db, owner: UUID, connection: UUID, lock: bool = False) -> dict:
    with db.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            "SELECT * FROM live_connections WHERE owner_id = %s AND id = %s AND status <> 'REVOKED'"
            + (" FOR UPDATE" if lock else ""),
            (owner, connection),
        ).fetchone()
    if row is None:
        raise LookupError("Connection unavailable")
    return row


def _client(row: dict, vault: CredentialVault, factory: ClientFactory) -> ExchangeClient:
    secret = vault.open(row["owner_id"], row["id"], bytes(row["nonce"]), bytes(row["ciphertext"]))
    return factory(row["exchange"], row["environment"], secret)


def account_summary(db, owner, connection, vault, factory, price) -> dict:
    row = _load(db, owner, connection)
    client = _client(row, vault, factory)
    try:
        raw = client.balances()
    finally:
        client.close()
    balances, total, complete = [], Decimal(0), True
    for item in raw:
        amount = item["free"] + item["locked"]
        if amount <= 0:
            continue
        asset = item["asset"]
        mark = Decimal(1) if asset in STABLECOINS else price(asset) if asset in ASSETS else None
        value = (amount * mark).quantize(Decimal("0.01")) if mark is not None else None
        if value is None:
            complete = False
        else:
            total += value
        balances.append(
            {
                "asset": asset,
                "free": item["free"],
                "locked": item["locked"],
                "total": amount,
                "price": mark,
                "value": value,
            }
        )
    balances.sort(key=lambda b: b["value"] if b["value"] is not None else Decimal(-1), reverse=True)
    return {
        "connection": _public(row),
        "balances": balances,
        "total_value": total,
        "complete": complete,
    }


def control_connection(db, owner, connection, action, vault, factory) -> dict:
    """Pause is the kill switch: block new orders (manual and agent) and cancel open orders."""
    with db.transaction():
        row = _load(db, owner, connection, lock=True)
        status = "PAUSED" if action == "pause" else "ACTIVE"
        db.execute(
            "UPDATE live_connections SET status = %s WHERE owner_id = %s AND id = %s",
            (status, owner, connection),
        )
    cancelled, errors = 0, []
    if action == "pause":
        client = _client(row, vault, factory)
        try:
            assets = db.execute(
                """SELECT DISTINCT asset FROM live_orders
                   WHERE owner_id = %s AND connection_id = %s
                   AND status IN ('NEW', 'SUBMITTING', 'UNKNOWN', 'PARTIALLY_FILLED')""",
                (owner, connection),
            ).fetchall()
            for asset in sorted(set(ASSETS) | {asset for (asset,) in assets}):
                try:
                    cancelled += client.cancel_open_orders(asset)
                except ExchangeError as exc:
                    errors.append(f"{asset}: {safe_message(exc.message)}")
        finally:
            client.close()
    return {"status": status, "cancelled_orders": cancelled, "errors": errors}


def revoke_connection(db, owner: UUID, connection: UUID):
    with db.transaction():
        db.execute(
            """
            UPDATE paper_agents SET live_connection_id = NULL, live_budget = NULL,
                live_since = NULL
            WHERE owner_id = %s AND live_connection_id = %s
            """,
            (owner, connection),
        )
        result = db.execute(
            """
            UPDATE live_connections SET status = 'REVOKED', nonce = NULL, ciphertext = NULL
            WHERE owner_id = %s AND id = %s AND status <> 'REVOKED'
            """,
            (owner, connection),
        )
    if result.rowcount == 0:
        raise LookupError("Connection unavailable")


# ---------------------------------------------------------------- orders
def _order(db, owner: UUID, order_id: UUID) -> dict:
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            "SELECT * FROM live_orders WHERE owner_id = %s AND id = %s", (owner, order_id)
        ).fetchone()


def _apply(db, order_id: UUID, outcome: dict | None, *, status=None, error=None):
    outcome = outcome or {}
    db.execute(
        """
        UPDATE live_orders SET status = %s,
            exchange_order_id = coalesce(%s, exchange_order_id),
            executed_qty = coalesce(%s, executed_qty), quote_filled = coalesce(%s, quote_filled),
            average_price = coalesce(%s, average_price), fees = coalesce(%s, fees),
            error = %s, updated_at = now()
        WHERE id = %s
        """,
        (
            status or outcome.get("status", "UNKNOWN"),
            outcome.get("order_id"),
            outcome.get("executed_qty"),
            outcome.get("quote_filled"),
            outcome.get("average_price"),
            Jsonb(outcome["fees"]) if outcome.get("fees") else None,
            error,
            order_id,
        ),
    )


def _reconcile(db, client: ExchangeClient, order: dict):
    """Ask the exchange what happened to an order whose outcome is unknown."""
    try:
        outcome = client.order(order["asset"], order["client_order_id"])
    except ExchangeError as exc:
        if exc.not_found:
            _apply(db, order["id"], None, status="REJECTED", error="Order was not accepted")
        else:
            _apply(db, order["id"], None, status="UNKNOWN", error=safe_message(exc.message))
        return
    _apply(db, order["id"], outcome)


def _insert_order(db, connection: dict, **fields) -> UUID:
    order_id = uuid4()
    db.execute(
        """
        INSERT INTO live_orders (id, owner_id, connection_id, request_key, client_order_id, asset,
            side, quote_amount, quantity, agent_id, paper_order_id, status, error)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            order_id,
            connection["owner_id"],
            connection["id"],
            fields["request_key"],
            client_order_id(connection["exchange"], fields["request_key"]),
            fields["asset"],
            fields["side"],
            fields.get("quote_amount"),
            fields.get("quantity"),
            fields.get("agent_id"),
            fields.get("paper_order_id"),
            fields.get("status", "SUBMITTING"),
            fields.get("error"),
        ),
    )
    return order_id


def _send(db, connection: dict, order_id: UUID, vault, factory) -> dict:
    """Submit an inserted order. Runs outside any transaction so no lock waits on the network."""
    order = _order(db, connection["owner_id"], order_id)
    client = _client(connection, vault, factory)
    try:
        try:
            try:
                supported = client.spot_assets(order["asset"])
            except ExchangeError as exc:
                raise ExchangeError(exc.message) from None
            if order["asset"] not in supported:
                raise ExchangeError(f"{order['asset']}/USDT is unavailable on this exchange")
            outcome = client.market_order(
                order["asset"],
                order["side"],
                order["client_order_id"],
                quote_amount=order["quote_amount"],
                quantity=order["quantity"],
            )
            _apply(db, order_id, outcome)
        except ExchangeError as exc:
            if exc.unknown_outcome:
                _reconcile(db, client, order)
            else:
                _apply(db, order_id, None, status="REJECTED", error=safe_message(exc.message))
    finally:
        client.close()
    return _order(db, connection["owner_id"], order_id)


def place_order(db, owner, connection, request: LiveOrderRequest, vault, factory) -> dict:
    with db.transaction():
        row = _load(db, owner, connection, lock=True)
        with db.cursor(row_factory=dict_row) as cursor:
            existing = cursor.execute(
                "SELECT * FROM live_orders WHERE owner_id = %s AND request_key = %s",
                (owner, request.request_key),
            ).fetchone()
        if existing:
            same = (
                existing["connection_id"] == connection
                and existing["asset"] == request.asset
                and existing["side"] == request.side
                and existing["quote_amount"] == request.quote_amount
            )
            if not same:
                raise LiveRejected("This request key was already used for a different order")
        else:
            if row["status"] != "ACTIVE":
                raise LiveRejected("Trading is paused for this connection. Resume it first.")
            if request.quote_amount > row["max_order_usdt"]:
                raise LiveRejected(
                    f"Order exceeds this connection's limit of {row['max_order_usdt']} USDT"
                )
            if row["environment"] == "live" and not request.acknowledge_live:
                raise LiveRejected("Confirm that this order uses real funds")
            order_id = _insert_order(
                db,
                row,
                request_key=request.request_key,
                asset=request.asset,
                side=request.side,
                quote_amount=request.quote_amount,
            )
    if existing:
        if existing["status"] in {"SUBMITTING", "UNKNOWN"}:
            client = _client(row, vault, factory)
            try:
                _reconcile(db, client, existing)
            finally:
                client.close()
        return _order(db, owner, existing["id"])
    return _send(db, row, order_id, vault, factory)


_ORDER_COLUMNS = """id, request_key, client_order_id, exchange_order_id, asset, side, quote_amount,
    quantity, agent_id, status, executed_qty, quote_filled, average_price, fees, error,
    created_at, updated_at"""


def connection_spot_assets(db, owner, connection, vault, factory, asset=None) -> list[str]:
    row = _load(db, owner, connection)
    client = _client(row, vault, factory)
    try:
        return client.spot_assets(asset)
    finally:
        client.close()


def list_orders(db, owner: UUID, connection: UUID, limit: int = 50) -> list[dict]:
    _load(db, owner, connection)
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            f"""
            SELECT {_ORDER_COLUMNS} FROM live_orders WHERE owner_id = %s AND connection_id = %s
            ORDER BY created_at DESC LIMIT %s
            """,
            (owner, connection, limit),
        ).fetchall()


# ---------------------------------------------------------------- agents
def agent_live_orders(db, owner: UUID, agent: UUID, limit: int = 50) -> list[dict]:
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            f"""
            SELECT {_ORDER_COLUMNS} FROM live_orders WHERE owner_id = %s AND agent_id = %s
            ORDER BY created_at DESC LIMIT %s
            """,
            (owner, agent, limit),
        ).fetchall()


def live_holding(db, owner: UUID, agent: UUID, asset: str) -> Decimal:
    """Base asset the agent bought live and still holds, net of fees charged in that asset."""
    with db.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            """
            SELECT side, executed_qty, fees FROM live_orders
            WHERE owner_id = %s AND agent_id = %s AND asset = %s
              AND status IN ('FILLED', 'PARTIALLY_FILLED', 'CANCELED', 'EXPIRED')
              AND executed_qty > 0
            """,
            (owner, agent, asset),
        ).fetchall()
    held = Decimal(0)
    for row in rows:
        fee = Decimal(str((row["fees"] or {}).get(asset, "0")))
        held += row["executed_qty"] - fee if row["side"] == "BUY" else -row["executed_qty"]
    return max(held, Decimal(0))


def promote_agent(db, owner: UUID, agent: UUID, request: Promotion, vault, factory) -> dict:
    from backend.product.agents import event

    selection = db.execute(
        """
        SELECT v.document->'definition'->>'asset'
        FROM paper_agents a JOIN platform_strategy_versions v
          ON (v.owner_id, v.strategy_id, v.version) =
             (a.owner_id, a.strategy_id, a.strategy_version)
        WHERE a.owner_id = %s AND a.id = %s
        """,
        (owner, agent),
    ).fetchone()
    if selection is None:
        raise LookupError("Agent unavailable")
    (asset,) = selection
    if asset not in connection_spot_assets(db, owner, request.connection_id, vault, factory, asset):
        raise LiveRejected(f"{asset}/USDT is unavailable on this exchange")

    with db.transaction():
        with db.cursor(row_factory=dict_row) as cursor:
            row = cursor.execute(
                """
                SELECT status, stage, created_at, live_connection_id FROM paper_agents
                WHERE owner_id = %s AND id = %s FOR UPDATE
                """,
                (owner, agent),
            ).fetchone()
        if row is None:
            raise LookupError("Agent unavailable")
        connection = _load(db, owner, request.connection_id, lock=True)
        if row["live_connection_id"]:
            raise LiveRejected("This agent is already trading live")
        if row["status"] != "RUNNING" or row["stage"] != "MONITOR":
            raise LiveRejected("Only a running agent that passed validation can go live")
        if connection["status"] != "ACTIVE":
            raise LiveRejected("The exchange connection is paused")
        if connection["environment"] == "live":
            if not request.acknowledge_live:
                raise LiveRejected("Confirm that this agent will trade real funds")
            (age,) = db.execute("SELECT now() - %s", (row["created_at"],)).fetchone()
            if age < timedelta(days=promotion_days()):
                raise LiveRejected(
                    f"Agents need {promotion_days()} days of paper trading before trading real "
                    "funds. Use a testnet connection to try it now."
                )
        db.execute(
            """
            UPDATE paper_agents SET live_connection_id = %s, live_budget = %s, live_since = now()
            WHERE owner_id = %s AND id = %s
            """,
            (request.connection_id, request.budget_usdt, owner, agent),
        )
        event(
            db,
            owner,
            agent,
            "LIVE_PROMOTED",
            {
                "exchange": connection["exchange"],
                "environment": connection["environment"],
                "label": connection["label"],
                "budget_usdt": str(request.budget_usdt),
            },
        )
    return {"agent": agent, "connection_id": request.connection_id, "live": True}


def demote_agent(db, owner: UUID, agent: UUID, request: Demotion, vault, factory) -> dict:
    from backend.product.agents import event

    with db.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(
            """
            SELECT a.live_connection_id, v.document->'definition'->>'asset' AS asset
            FROM paper_agents a JOIN platform_strategy_versions v
              ON (v.owner_id, v.strategy_id, v.version) = (a.owner_id, a.strategy_id,
                  a.strategy_version)
            WHERE a.owner_id = %s AND a.id = %s
            """,
            (owner, agent),
        ).fetchone()
    if row is None or row["live_connection_id"] is None:
        raise LookupError("Agent is not trading live")
    closed = None
    if request.close_position:
        held = live_holding(db, owner, agent, row["asset"])
        if held > 0:
            connection = _load(db, owner, row["live_connection_id"])
            with db.transaction():
                order_id = _insert_order(
                    db,
                    connection,
                    request_key=uuid4(),
                    asset=row["asset"],
                    side="SELL",
                    quantity=held,
                    agent_id=agent,
                )
            closed = _send(db, connection, order_id, vault, factory)
    with db.transaction():
        db.execute(
            """
            UPDATE paper_agents SET live_connection_id = NULL, live_budget = NULL,
                live_since = NULL
            WHERE owner_id = %s AND id = %s
            """,
            (owner, agent),
        )
        event(db, owner, agent, "LIVE_STOPPED", {"closed_position": bool(closed)})
    return {"agent": agent, "live": False, "close_order": closed}


def _paper_position(db, owner, agent, asset) -> Decimal:
    (quantity,) = db.execute(
        """
        SELECT coalesce(sum(l.quantity), 0) FROM paper_ledger_entries l
        JOIN paper_orders o ON o.id = l.order_id
        WHERE o.owner_id = %s AND o.agent_id = %s AND l.asset = %s
        """,
        (owner, agent, asset),
    ).fetchone()
    return Decimal(quantity)


def mirror_fills(db, vault: CredentialVault, factory: ClientFactory, limit: int = 5) -> int:
    """Copy new paper fills of promoted agents to their exchanges. Safe to run concurrently."""
    from backend.product.agents import event

    with db.cursor(row_factory=dict_row) as cursor:
        pending = cursor.execute(
            """
            SELECT o.id AS paper_order_id, o.owner_id, o.agent_id, l.kind, l.asset,
                abs(l.quantity) AS quantity, abs(l.amount) AS notional, a.capital,
                a.live_connection_id, a.live_budget
            FROM paper_agents a
            JOIN paper_orders o ON o.owner_id = a.owner_id AND o.agent_id = a.id
                AND o.status = 'FILLED' AND o.updated_at >= a.live_since
            JOIN paper_ledger_entries l ON l.order_id = o.id AND l.kind IN ('BUY', 'SELL')
            WHERE a.live_connection_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM live_orders lo WHERE lo.paper_order_id = o.id)
            ORDER BY o.updated_at LIMIT %s
            """,
            (limit,),
        ).fetchall()
    sent = 0
    for fill in pending:
        owner, agent, asset = fill["owner_id"], fill["agent_id"], fill["asset"]
        connection = _load(db, owner, fill["live_connection_id"])
        fields = {
            "request_key": uuid5(MIRROR_NAMESPACE, str(fill["paper_order_id"])),
            "asset": asset,
            "side": fill["kind"],
            "agent_id": agent,
            "paper_order_id": fill["paper_order_id"],
        }
        skip = None
        if fill["kind"] == "BUY":
            amount = (fill["notional"] * fill["live_budget"] / fill["capital"]).quantize(
                Decimal("0.01"), rounding=ROUND_DOWN
            )
            amount = min(amount, connection["max_order_usdt"])
            fields["quote_amount"] = max(amount, Decimal("0.01"))
            if amount < MIN_ORDER_USDT:
                skip = f"Scaled order of {amount} USDT is below the {MIN_ORDER_USDT} USDT minimum"
        else:
            remaining = max(_paper_position(db, owner, agent, asset), Decimal(0))
            share = fill["quantity"] / (fill["quantity"] + remaining)
            held = live_holding(db, owner, agent, asset)
            fields["quantity"] = (held * share) if held > 0 else Decimal("0.00000001")
            if held <= 0:
                skip = "No live position to sell"
        if connection["status"] != "ACTIVE":
            skip = "Connection paused by the kill switch"
        try:
            with db.transaction():
                order_id = _insert_order(
                    db, connection, **fields, status="SKIPPED" if skip else "SUBMITTING", error=skip
                )
        except UniqueViolation:
            continue  # Another worker took this fill.
        if skip:
            event(db, owner, agent, "LIVE_SKIPPED", {"side": fill["kind"], "reason": skip})
            continue
        order = _send(db, connection, order_id, vault, factory)
        event(
            db,
            owner,
            agent,
            "LIVE_ORDER",
            {
                "side": order["side"],
                "asset": asset,
                "status": order["status"],
                "executed_qty": str(order["executed_qty"] or 0),
                "average_price": str(order["average_price"] or ""),
                "error": order["error"],
            },
        )
        sent += 1
    return sent
