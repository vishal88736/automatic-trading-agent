"""The Phase 1 CLI: real, read-only prices from a single confirmed block."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from aegis.connectors.rpc import DiscoveryError
from aegis.data import HSKSwapData, load_network


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=["mainnet", "testnet"], default="mainnet")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--output", type=Path, help="Save this observation as timestamped evidence")
    args = parser.parse_args()
    reader = HSKSwapData(load_network(args.network))
    try:
        snapshot = reader.snapshot()
    except DiscoveryError as exc:
        print(f"VERIFICATION FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        reader.close()
    document = {
        "observed_at": datetime.now(UTC).isoformat(),
        **snapshot.model_dump(mode="json"),
    }
    rendered = json.dumps(document, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    if args.json:
        print(rendered, end="")
        return 0
    print(f"AEGIS | READ-ONLY {args.network} | chain {snapshot.chain_id}")
    print(
        f"Block {snapshot.block_number} | {snapshot.block_hash} | "
        f"{snapshot.confirmations} blocks behind head"
    )
    if snapshot.chain_id == 133:
        print("Testnet assets are synthetic. Their balances are not real USD TVL.")
    for p in snapshot.pools:
        symbol0, symbol1 = snapshot.tokens[p.token0].symbol, snapshot.tokens[p.token1].symbol
        print(f"\n{symbol0}/{symbol1} | pool {p.address} | fee {p.fee_pips / 10000:g}%")
        print(f"  1 {symbol0} = {p.mid_token1_per_token0:.12g} {symbol1} (mid price)")
        print(f"  Token balances: {p.balance0:.16g} {symbol0}, {p.balance1:.16g} {symbol1}")
        print(f"  Active V3 liquidity: {p.active_liquidity_raw} | tick: {p.tick}")
        print(f"  Spot balance value: {p.balance_value_in_token1:.12g} {symbol1}")
        if int(p.active_liquidity_raw) == 0 or not p.unlocked:
            print("  NOT TRADABLE at this tick (no active liquidity or locked pool)")
    print("\nV3 token balances are not V2 reserves. Mid prices exclude fees, slippage and gas.")
    print("No wallet, signing, swap, or strategy is enabled by this command.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
