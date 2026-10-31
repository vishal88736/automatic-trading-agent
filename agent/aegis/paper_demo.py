"""Phase 2 operational round trip with live quotes and a private paper ledger."""

from __future__ import annotations

import argparse
import json
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import yaml

from aegis.connectors.hskswap_v3 import HSKSwapConnector
from aegis.connectors.paper import PaperConnector, PaperTerms
from aegis.connectors.rpc import DiscoveryError
from aegis.data import ROOT, load_network
from aegis.execution.gateway import ExecutionGateway
from aegis.risk.engine import PaperLimits, RiskEngine, RiskRejected
from aegis.store.db import LedgerError, PaperLedger


def units(value: str, decimals: int) -> int:
    raw = Decimal(value) * 10**decimals
    if not raw.is_finite() or raw <= 0 or raw != int(raw):
        raise ValueError("Amount must be positive and fit the token's decimal precision")
    return int(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(".runtime/aegis-paper.sqlite3"))
    parser.add_argument("--initial-cash", default=None)
    parser.add_argument("--config", type=Path, default=ROOT / "config/strategy.yaml")
    parser.add_argument(
        "--amount", default="1", help="Virtual USDT spent on the validation round trip"
    )
    parser.add_argument(
        "--intent-prefix",
        default=None,
        help="Reuse to recover/replay the same two idempotent intents",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    connector = HSKSwapConnector(load_network())
    stable, base = connector.tokens["USDT"], connector.tokens["WHSK"]
    try:
        config = yaml.safe_load(args.config.read_text())
        if config.get("schema_version") != 1 or config.get("mode") != "paper":
            raise ValueError("The validation demo requires schema version 1 and paper mode")
        terms = PaperTerms.model_validate(
            {k: v for k, v in config["paper"].items() if k != "initial_cash_usdt"}
        )
        limits = PaperLimits.model_validate(config["risk"])
        amount = units(args.amount, stable.decimals)
        funding = units(args.initial_cash or config["paper"]["initial_cash_usdt"], stable.decimals)
        ledger = PaperLedger(args.db, stable, funding)
    except (ValueError, OSError, KeyError) as exc:
        connector.close()
        parser.error(str(exc))
    gateway = ExecutionGateway(PaperConnector(connector, terms), ledger, RiskEngine(limits))
    run_id = args.intent_prefix or str(uuid4())
    print(
        f"AEGIS PAPER | run {run_id} | real mainnet quotes, virtual balances; no signed transactions",
        flush=True,
    )
    try:
        buy = gateway.execute(run_id + ":buy", stable, base, amount)
        sell = gateway.execute(run_id + ":sell", base, stable, int(buy["amount_out_filled_raw"]))
        report = {
            "run_id": run_id,
            "mode": "paper",
            "data_source": "HSKSwap mainnet QuoterV2",
            "buy": buy,
            "sell": sell,
            "pnl": ledger.pnl(gateway.marks()),
            "methodology": gateway.connector.terms.model_dump(mode="json"),
            "purpose": "Operational validation round trip, not an alpha or sustained-profitability run.",
            "transactions_sent": 0,
            "on_chain_decision_log": "Not deployed; Phase 2 decisions are local SQLite records.",
        }
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report["pnl"], indent=2))
        print(f"Receipts: {buy['receipt']} / {sell['receipt']}")
        print(
            f"Fees: Quoter LP fees once, {terms.extra_slippage_bps} bps modeled extra slippage, {terms.network_fee_usdt} virtual USDT network expense per fill."
        )
        return 0
    except (DiscoveryError, RiskRejected, LedgerError) as exc:
        print(
            f"Stopped safely: {exc}. Resume with --intent-prefix {run_id}; the ledger was preserved."
        )
        return 1
    finally:
        ledger.close()
        connector.close()


if __name__ == "__main__":
    raise SystemExit(main())
