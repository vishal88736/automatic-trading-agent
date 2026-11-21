"""Live trading on a user's own exchange account.

Krono stores an encrypted, trade-only API key, checks its permissions before saving it, and
places market orders sized in USDT. Orders are idempotent: the request key becomes the
exchange client order ID, so a retry or a crash can never submit twice. Funds never leave the
user's exchange account, and keys that can withdraw are rejected.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID, uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import Field, StringConstraints

from backend.models import Model
from backend.product.binance import BinanceClient, BinanceError, Environment, fill_summary
from backend.product.credentials import CredentialVault
from backend.product.price_hub import ASSETS

ClientFactory = Callable[[Environment, str, str], BinanceClient]
STABLECOINS = {"USDT", "USDC", "FDUSD"}
KeyText = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9]{16,128}$")]
Usdt = Annotated[Decimal, Field(gt=0, le=100000, decimal_places=2)]


class LinkRequest(Model):
    exchange: Literal["binance"] = "binance"
    environment: Environment = "testnet"
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    api_key: KeyText
    api_secret: KeyText
    max_order_usdt: Usdt = Decimal("100")


class LiveOrderRequest(Model):
    request_key: UUID
    asset: Literal["BTC", "ETH", "SOL"]
    side: Literal["BUY", "SELL"]
    quote_amount: Usdt
    acknowledge_live: bool = False


class LiveCommand(Model):
    action: Literal["pause", "resume"]


def default_client(environment: Environment, key: str, secret: str) -> BinanceClient:
    return BinanceClient(key, secret, environment)


def _public(row: dict) -> dict:
    return {
        key: row[key]
        for key in (
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
    }


def link_connection(
    db, owner: UUID, request: LinkRequest, vault: CredentialVault, factory: ClientFactory
) -> dict:
    client = factory(request.environment, request.api_key, request.api_secret)
    try:
        try:
            account = client.account()
        except BinanceError as exc:
            raise ValueError(f"Binance rejected the key: {safe_message(exc.message)}") from None
        if not account.get("canTrade"):
            raise ValueError("This key cannot trade. Enable Spot trading for the key and retry.")
        permissions: dict = {"can_trade": True}
        if request.environment == "live":
            try:
                restrictions = client.api_restrictions()
            except BinanceError as exc:
                raise ValueError(
                    f"Key permissions could not be checked: {safe_message(exc.message)}"
                ) from None
            if restrictions.get("enableWithdrawals"):
                raise ValueError(
                    "This key can withdraw funds. Create a key with withdrawals disabled."
                )
            if not restrictions.get("enableSpotAndMarginTrading"):
                raise ValueError("Enable Spot & Margin trading for this key and retry.")
            permissions |= {
                "withdrawals": False,
                "ip_restricted": bool(restrictions.get("ipRestrict")),
            }
        else:
            permissions |= {"withdrawals": "testnet funds only", "ip_restricted": None}
    finally:
        client.close()

    connection = uuid4()
    nonce, ciphertext = vault.seal(
        owner, connection, {"api_key": request.api_key, "api_secret": request.api_secret}
    )
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


def _client(row: dict, vault: CredentialVault, factory: ClientFactory) -> BinanceClient:
    secret = vault.open(row["owner_id"], row["id"], bytes(row["nonce"]), bytes(row["ciphertext"]))
    return factory(row["environment"], secret["api_key"], secret["api_secret"])


def account_summary(
    db,
    owner: UUID,
    connection: UUID,
    vault: CredentialVault,
    factory: ClientFactory,
    price: Callable[[str], Decimal | None],
) -> dict:
    row = _load(db, owner, connection)
    client = _client(row, vault, factory)
    try:
        account = client.account()
    finally:
        client.close()
    balances, total, complete = [], Decimal(0), True
    for item in account.get("balances", []):
        free, locked = Decimal(item["free"]), Decimal(item["locked"])
        amount = free + locked
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
                "free": free,
                "locked": locked,
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
        "can_trade": bool(account.get("canTrade")),
    }


def client_order_id(request_key: UUID) -> str:
    return "kr-" + request_key.hex


def _apply(db, order_id: UUID, response: dict | None, *, status=None, error=None):
    summary = fill_summary(response) if response else {}
    db.execute(
        """
        UPDATE live_orders SET status = %s, exchange_order_id = coalesce(%s, exchange_order_id),
            executed_qty = coalesce(%s, executed_qty), quote_filled = coalesce(%s, quote_filled),
            average_price = coalesce(%s, average_price), fees = coalesce(%s, fees),
            error = %s, updated_at = now()
        WHERE id = %s
        """,
        (
            status or (response or {}).get("status", "UNKNOWN"),
            (response or {}).get("orderId"),
            summary.get("executed_qty"),
            summary.get("quote_filled"),
            summary.get("average_price"),
            Jsonb(summary["fees"]) if summary.get("fees") else None,
            error,
            order_id,
        ),
    )


def _order(db, owner: UUID, order_id: UUID) -> dict:
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            "SELECT * FROM live_orders WHERE owner_id = %s AND id = %s", (owner, order_id)
        ).fetchone()


def _reconcile(db, client: BinanceClient, order: dict):
    """Ask the exchange what happened to an order whose outcome is unknown."""
    try:
        response = client.order(ASSETS[order["asset"]], order["client_order_id"])
    except BinanceError as exc:
        if exc.code == -2013:  # Order does not exist: it was never accepted.
            _apply(db, order["id"], None, status="REJECTED", error="Order was not accepted")
        else:
            _apply(db, order["id"], None, status="UNKNOWN", error=safe_message(exc.message))
        return
    _apply(db, order["id"], response)


def place_order(
    db,
    owner: UUID,
    connection: UUID,
    request: LiveOrderRequest,
    vault: CredentialVault,
    factory: ClientFactory,
) -> dict:
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
                raise ValueError("This request key was already used for a different order")
        else:
            if row["status"] != "ACTIVE":
                raise ValueError("Trading is paused for this connection. Resume it first.")
            if request.quote_amount > row["max_order_usdt"]:
                raise ValueError(
                    f"Order exceeds this connection's limit of {row['max_order_usdt']} USDT"
                )
            if row["environment"] == "live" and not request.acknowledge_live:
                raise ValueError("Confirm that this order uses real funds")
            order_id = uuid4()
            db.execute(
                """
                INSERT INTO live_orders (id, owner_id, connection_id, request_key,
                    client_order_id, asset, side, quote_amount, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'SUBMITTING')
                """,
                (
                    order_id,
                    owner,
                    connection,
                    request.request_key,
                    client_order_id(request.request_key),
                    request.asset,
                    request.side,
                    request.quote_amount,
                ),
            )
            existing = None
    # The network call happens outside the transaction so no lock is held while waiting.
    client = _client(row, vault, factory)
    try:
        if existing:
            if existing["status"] in {"SUBMITTING", "UNKNOWN"}:
                _reconcile(db, client, existing)
            return _order(db, owner, existing["id"])
        try:
            response = client.market_order(
                ASSETS[request.asset],
                request.side,
                request.quote_amount,
                client_order_id(request.request_key),
            )
            _apply(db, order_id, response)
        except BinanceError as exc:
            if exc.unknown_outcome:
                _reconcile(db, client, _order(db, owner, order_id))
            else:
                _apply(db, order_id, None, status="REJECTED", error=safe_message(exc.message))
        return _order(db, owner, order_id)
    finally:
        client.close()


def list_orders(db, owner: UUID, connection: UUID, limit: int = 50) -> list[dict]:
    _load(db, owner, connection)
    with db.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(
            """
            SELECT id, request_key, client_order_id, exchange_order_id, asset, side, quote_amount,
                status, executed_qty, quote_filled, average_price, fees, error, created_at,
                updated_at
            FROM live_orders WHERE owner_id = %s AND connection_id = %s
            ORDER BY created_at DESC LIMIT %s
            """,
            (owner, connection, limit),
        ).fetchall()


def control_connection(
    db,
    owner: UUID,
    connection: UUID,
    action: Literal["pause", "resume"],
    vault: CredentialVault,
    factory: ClientFactory,
) -> dict:
    """Pause is the kill switch: block new orders and cancel every open Krono market."""
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
            for symbol in ASSETS.values():
                try:
                    cancelled += len(client.cancel_open_orders(symbol))
                except BinanceError as exc:
                    errors.append(f"{symbol}: {safe_message(exc.message)}")
        finally:
            client.close()
    return {"status": status, "cancelled_orders": cancelled, "errors": errors}


def revoke_connection(db, owner: UUID, connection: UUID):
    result = db.execute(
        """
        UPDATE live_connections SET status = 'REVOKED', nonce = NULL, ciphertext = NULL
        WHERE owner_id = %s AND id = %s AND status <> 'REVOKED'
        """,
        (owner, connection),
    )
    if result.rowcount == 0:
        raise LookupError("Connection unavailable")


def safe_message(message: str) -> str:
    # Exchange errors can echo request fragments; never return anything key-shaped.
    return re.sub(r"[A-Za-z0-9]{32,}", "[redacted]", message)[:300]
