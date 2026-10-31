"""Atomic, idempotent paper ledger; token units are TEXT, never SQLite floats."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from decimal import Decimal, localcontext
from pathlib import Path
from uuid import uuid4

from aegis.connectors.base import Quote, Token


class LedgerError(ValueError):
    pass


class PaperLedger:
    def __init__(self, path: Path, stable: Token, initial_cash_raw: int):
        if initial_cash_raw <= 0:
            raise LedgerError("Initial virtual cash must be positive")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.stable = stable
        self.db = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=10000")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS balances(asset TEXT PRIMARY KEY, token_json TEXT NOT NULL, amount_raw TEXT NOT NULL, cost_usdt TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ticks(block_hash TEXT PRIMARY KEY, block_number INTEGER NOT NULL, snapshot_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS fills(id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL);
        """)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            identity = json.dumps(
                {
                    "chain_id": stable.chain_id,
                    "stable": stable.address.lower(),
                    "decimals": stable.decimals,
                    "initial_cash_raw": str(initial_cash_raw),
                },
                sort_keys=True,
            )
            previous = self.db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
            if previous is not None and previous[0] != identity:
                raise LedgerError(
                    "Ledger identity or initial funding changed; use its original settings or a new database"
                )
            if previous is None:
                self.db.execute("INSERT INTO metadata VALUES('identity', ?)", (identity,))
                self.db.execute(
                    "INSERT INTO balances VALUES(?,?,?,?)",
                    (
                        stable.address.lower(),
                        stable.model_dump_json(),
                        str(initial_cash_raw),
                        str(Decimal(initial_cash_raw) / 10**stable.decimals),
                    ),
                )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            self.db.close()
            raise

    def close(self) -> None:
        self.db.close()

    @staticmethod
    def request_hash(payload: dict) -> str:
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    def previous(self, key: str, request_hash: str) -> dict | None:
        row = self.db.execute(
            "SELECT request_hash,result_json FROM fills WHERE idempotency_key=?", (key,)
        ).fetchone()
        if row is None:
            return None
        if row["request_hash"] != request_hash:
            raise LedgerError("Idempotency key was already used for a different trade")
        return json.loads(row["result_json"])

    def balances(self) -> dict[str, dict]:
        return {
            row["asset"]: {
                "token": Token.model_validate_json(row["token_json"]),
                "amount_raw": int(row["amount_raw"]),
                "cost_usdt": Decimal(row["cost_usdt"]),
            }
            for row in self.db.execute("SELECT * FROM balances")
        }

    def record(self, status: str, payload: dict) -> None:
        self.db.execute(
            "INSERT INTO decisions VALUES(?,?,?,?)",
            (str(uuid4()), int(time.time()), status, json.dumps(payload, sort_keys=True)),
        )

    def save_tick(self, quote: Quote) -> None:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            existing = self.db.execute(
                "SELECT snapshot_json FROM ticks WHERE block_hash=?", (quote.block_hash,)
            ).fetchone()
            states = (
                {s["pool"]["address"].lower(): s for s in json.loads(existing[0])}
                if existing
                else {}
            )
            for state in quote.states:
                key = state.pool.address.lower()
                value = state.model_dump(mode="json")
                if key in states and states[key] != value:
                    raise LedgerError("Conflicting state for the same pool and block hash")
                states[key] = value
            self.db.execute(
                "INSERT INTO ticks VALUES(?,?,?) ON CONFLICT(block_hash) DO UPDATE SET snapshot_json=excluded.snapshot_json",
                (quote.block_hash, quote.block_number, json.dumps(list(states.values()))),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def apply_fill(
        self,
        *,
        key: str,
        request_hash: str,
        quote: Quote,
        output_raw: int,
        network_fee_raw: int,
        marks: dict[str, Decimal],
        max_trade_bps: int,
    ) -> dict:
        if output_raw <= 0 or network_fee_raw < 0 or not 0 < max_trade_bps <= 3000:
            raise LedgerError("Invalid fill amount, fee or NAV cap")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            previous = self.previous(key, request_hash)
            if previous is not None:
                self.db.execute("COMMIT")
                return previous
            if int(time.time()) > quote.expires_at:
                raise LedgerError("Quote expired before ledger commit")
            with localcontext() as ctx:
                ctx.prec = 78
                rows = self.balances()
                first, last = quote.route.tokens[0], quote.route.tokens[-1]
                if first == last:
                    raise LedgerError(
                        "Same-asset round trips require an atomic cycle-specific ledger operation"
                    )
                if first.chain_id != self.stable.chain_id or last.chain_id != self.stable.chain_id:
                    raise LedgerError("Quote and ledger chains differ")
                for token in [first, last, self.stable]:
                    rows.setdefault(
                        token.address.lower(),
                        {"token": token, "amount_raw": 0, "cost_usdt": Decimal(0)},
                    )
                incoming, outgoing, cash = (
                    rows[first.address.lower()],
                    rows[last.address.lower()],
                    rows[self.stable.address.lower()],
                )
                if any(marks[a] <= 0 for a in rows):
                    raise LedgerError("All portfolio marks must be positive")
                nav = sum(
                    Decimal(r["amount_raw"]) / 10 ** r["token"].decimals * marks[a]
                    for a, r in rows.items()
                )
                input_value = (
                    Decimal(quote.amount_in_raw) / 10**first.decimals * marks[first.address.lower()]
                )
                if input_value * 10000 > nav * max_trade_bps:
                    raise LedgerError(
                        "Trade exceeds current NAV cap inside the atomic ledger transaction"
                    )
                if incoming["amount_raw"] < quote.amount_in_raw:
                    raise LedgerError("Insufficient paper token balance")
                removed_cost = (
                    incoming["cost_usdt"]
                    if quote.amount_in_raw == incoming["amount_raw"]
                    else incoming["cost_usdt"] * quote.amount_in_raw / incoming["amount_raw"]
                )
                incoming["amount_raw"] -= quote.amount_in_raw
                incoming["cost_usdt"] -= removed_cost
                output_value = Decimal(output_raw) / 10**last.decimals * marks[last.address.lower()]
                gas_value = Decimal(network_fee_raw) / 10**self.stable.decimals
                realized = Decimal(0)
                if first.address.lower() == self.stable.address.lower():
                    new_cost = input_value + gas_value
                else:
                    realized = output_value - removed_cost - gas_value
                    new_cost = output_value
                outgoing["amount_raw"] += output_raw
                outgoing["cost_usdt"] += new_cost
                cash["amount_raw"] -= network_fee_raw
                if cash["amount_raw"] < 0:
                    raise LedgerError("Insufficient virtual USDT for modeled network fee")
                cash["cost_usdt"] = Decimal(cash["amount_raw"]) / 10**self.stable.decimals
                for address, row in rows.items():
                    self.db.execute(
                        "INSERT INTO balances VALUES(?,?,?,?) ON CONFLICT(asset) DO UPDATE SET amount_raw=excluded.amount_raw,cost_usdt=excluded.cost_usdt",
                        (
                            address,
                            row["token"].model_dump_json(),
                            str(row["amount_raw"]),
                            str(row["cost_usdt"]),
                        ),
                    )
                fill_id = str(uuid4())
                result = {
                    "id": fill_id,
                    "mode": "paper",
                    "receipt": "paper:" + fill_id,
                    "transaction_hash": None,
                    "created_at": int(time.time()),
                    "chain_id": self.stable.chain_id,
                    "quote": quote.model_dump(mode="json"),
                    "amount_out_filled_raw": str(output_raw),
                    "modeled_slippage_out_raw": str(quote.amount_out_raw - output_raw),
                    "modeled_network_fee_usdt": str(gas_value),
                    "lp_fee_input_raw_estimate": str(quote.lp_fee_input_raw_estimate),
                    "lp_fee_charged_again": False,
                    "realized_pnl_usdt": str(realized),
                    "fee_methodology": "Quoter output already includes LP fees. Additional slippage reduces output; configurable network cost is deducted from virtual USDT cash.",
                }
                self.db.execute(
                    "INSERT INTO fills VALUES(?,?,?,?)",
                    (fill_id, key, request_hash, json.dumps(result)),
                )
                self.record("paper_filled", {"fill_id": fill_id, "quote_id": quote.id})
                self.db.execute("COMMIT")
                return result
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    def fills(self) -> list[dict]:
        return [
            json.loads(r[0])
            for r in self.db.execute("SELECT result_json FROM fills ORDER BY rowid")
        ]

    def pnl(self, marks: dict[str, Decimal]) -> dict:
        with localcontext() as ctx:
            ctx.prec = 78
            balances = self.balances()
            nav = sum(
                Decimal(r["amount_raw"]) / 10 ** r["token"].decimals * marks[a]
                for a, r in balances.items()
            )
            identity = json.loads(
                self.db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()[0]
            )
            funding = Decimal(identity["initial_cash_raw"]) / 10**self.stable.decimals
            realized = sum((Decimal(f["realized_pnl_usdt"]) for f in self.fills()), Decimal(0))

            def text(value: Decimal) -> str:
                return format(value.normalize(), "f")

            return {
                "mode": "paper",
                "initial_cash_usdt": text(funding),
                "nav_usdt": text(nav),
                "net_pnl_usdt": text(nav - funding),
                "realized_pnl_usdt": text(realized),
                "unrealized_pnl_usdt": text(nav - funding - realized),
                "fills": len(self.fills()),
                "valuation_assumption": "USDT is the accounting numeraire; no independent USD peg is asserted.",
            }
