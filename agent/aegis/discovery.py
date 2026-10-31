"""Repeat Phase 1 source and same-block data checks. Never sends transactions."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

import httpx

from aegis.connectors.rpc import BlockRef, DiscoveryError
from aegis.data import HSKSwapData, Network, load_network

APP = "https://app.hskswap.com"
POOL_QUERY = """
query Snapshot($block: Int!) {
  _meta { block { number hash } hasIndexingErrors }
  v3Pools(first: 1000, block: {number: $block}, orderBy: id) {
    id feeTier liquidity sqrtPrice tick totalValueLockedUSD
    token0 { id symbol decimals }
    token1 { id symbol decimals }
  }
}
"""


def current_app_sources(client: httpx.Client, networks: list[Network]) -> list[dict]:
    sources = []

    def read(path: str) -> str:
        response = client.get(APP + path)
        response.raise_for_status()
        sources.append(
            {
                "url": str(response.url),
                "sha256": hashlib.sha256(response.content).hexdigest(),
                "bytes": len(response.content),
            }
        )
        return response.text

    html = read("/?lng=en-US")
    entry = re.search(r'<script[^>]+src="(/assets/index-[\w-]+\.js)"', html)
    if not entry:
        raise DiscoveryError("HSKSwap entry bundle layout changed; inspect the current app")
    bootstrap = read(entry[1])
    root = re.search(r"\./(src-[\w-]+\.js)", bootstrap)
    if not root:
        raise DiscoveryError("HSKSwap application import changed; repeat source discovery")
    app = read("/assets/" + root[1])
    docs = re.search(r"\./(DeveloperDocsPage-[\w-]+\.js)", app)
    if not docs:
        raise DiscoveryError("HSKSwap developer docs import changed; repeat source discovery")
    content = read("/assets/" + docs[1])
    for n in networks:
        for spec in n.contracts.values():
            if spec.address.lower() not in content.lower():
                raise DiscoveryError("Current HSKSwap developer docs no longer match the registry")
        if n.tokens[n.wrapped_native].address.lower() not in content.lower():
            raise DiscoveryError("Current app documents another wrapped native address")
    return sources


def compare_subgraph(client: httpx.Client, reader: HSKSwapData) -> dict:
    snapshot = reader.snapshot()
    response = client.post(
        reader.network.subgraph,
        json={"query": POOL_QUERY, "variables": {"block": snapshot.block_number}},
    )
    response.raise_for_status()
    document = response.json()
    if document.get("errors") or not document.get("data"):
        raise DiscoveryError("HSKSwap subgraph could not return the confirmed snapshot block")
    data = document["data"]
    if data["_meta"]["hasIndexingErrors"]:
        raise DiscoveryError("HSKSwap subgraph reports indexing errors")
    if len(data["v3Pools"]) >= 1000:
        raise DiscoveryError("Inventory requires pagination; do not report a truncated pool list")
    candidates = {p["id"].lower(): p for p in data["v3Pools"]}
    matches = []
    block = BlockRef(snapshot.block_number, snapshot.block_hash, snapshot.block_timestamp)
    for pool in snapshot.pools:
        candidate = candidates.get(pool.address.lower())
        if candidate is None:
            raise DiscoveryError("Verified pool missing from the current HSKSwap subgraph")
        t0, t1 = snapshot.tokens[pool.token0], snapshot.tokens[pool.token1]
        if (
            candidate["sqrtPrice"] != pool.sqrt_price_x96
            or candidate["liquidity"] != pool.active_liquidity_raw
            or int(candidate["tick"]) != pool.tick
            or int(candidate["feeTier"]) != pool.fee_pips
            or candidate["token0"]["id"].lower() != t0.address.lower()
            or candidate["token1"]["id"].lower() != t1.address.lower()
            or int(candidate["token0"]["decimals"]) != t0.decimals
            or int(candidate["token1"]["decimals"]) != t1.decimals
        ):
            raise DiscoveryError("Same-block subgraph state disagrees with direct RPC state")
        matches.append(
            {
                "pool": pool.address,
                "pair": f"{t0.symbol}/{t1.symbol}",
                "sqrt_price_x96_exact_match": True,
                "liquidity_exact_match": True,
                "tick_exact_match": True,
                "token_decimals_exact_match": True,
                "subgraph_tvl_usd_untrusted": candidate["totalValueLockedUSD"],
            }
        )
    reader.rpc.assert_canonical(block)
    reader.rpc.assert_fresh(block, reader.network.max_block_age_seconds)
    return {
        "snapshot": snapshot.model_dump(mode="json"),
        "subgraph_head": data["_meta"],
        "indexed_pool_count": len(candidates),
        "comparisons": matches,
        "inventory": data["v3Pools"],
        "visual_ui_comparison": "NOT_PERFORMED: this command checks source data, not the rendered UI",
        "transaction_sent": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=["mainnet", "testnet", "both"], default="both")
    parser.add_argument(
        "--output", type=Path, default=Path("docs/evidence/aegis-data-verification.json")
    )
    args = parser.parse_args()
    names = ["mainnet", "testnet"] if args.network == "both" else [args.network]
    networks = [load_network(n) for n in names]
    report = {"observed_at": datetime.now(UTC).isoformat(), "networks": {}}
    try:
        with httpx.Client(timeout=20, follow_redirects=True) as client:
            report["current_app_sources"] = current_app_sources(client, networks)
            for name, network in zip(names, networks, strict=True):
                reader = HSKSwapData(network)
                try:
                    result = compare_subgraph(client, reader)
                    report["networks"][name] = result
                finally:
                    reader.close()
                print(
                    f"{name}: chain {network.chain_id}, block {result['snapshot']['block_number']}, "
                    f"{len(result['comparisons'])} exact pool-state matches; "
                    f"{result['indexed_pool_count']} indexed pools"
                )
    except (DiscoveryError, httpx.HTTPError) as exc:
        # Do not print arbitrary remote bodies, request headers, or URL credentials.
        reason = str(exc) if isinstance(exc, DiscoveryError) else type(exc).__name__
        print(f"DISCOVERY CHECK FAILED: {reason}", file=sys.stderr)
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Evidence: {args.output}")
    print("Visual UI comparison requires a separate browser check. No transaction was sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
