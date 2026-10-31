"""Opt-in public read-only provider probe. Never signs or submits a transaction."""

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from backend.data import Providers
from backend.exchanges import HSKSwapAdapter
from backend.models import now
from backend.storage import Store


async def verify(output: str):
    store = Store(":memory:")
    providers = Providers(store, market_provider="coinbase", news_provider="cryptocurrency.cv")
    exchange = HSKSwapAdapter()
    report = {
        "retrieved_at": now().isoformat(),
        "execution_mode": "READ_ONLY_PROBE",
        "live_enabled": False,
        "transaction_submission_attempted": False,
        "providers": {},
    }
    try:
        market, news, breaking = await asyncio.gather(
            providers.market("BTC", refresh=True),
            providers.news(refresh=True),
            providers.news(True, refresh=True),
        )
        report["providers"]["coinbase"] = {
            "status": market.status,
            "source": market.source,
            "closed_candles": len(market.candles),
            "price_at": market.price_at.isoformat() if market.price_at else None,
            "candle_as_of": market.as_of.isoformat() if market.as_of else None,
        }
        for key, feed in (("news", news), ("breaking", breaking)):
            report["providers"][key] = {
                "status": feed.status,
                "source": feed.source,
                "normalized_articles": len(feed.articles),
                "articles_with_publication_time": len([a for a in feed.articles if a.published_at]),
                "retrieved_at": feed.retrieved_at.isoformat(),
                "error": feed.error,
                "limited": feed.limited,
                "max_results": feed.max_results,
                "provider_total": feed.provider_total,
            }
        try:
            result = await providers.request("https://cryptocurrency.cv/api/openapi.json")
            report["providers"]["openapi"] = {
                "status": "AVAILABLE",
                "sha256": hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest(),
                "parameters": {
                    p: [
                        q["name"]
                        for q in result.get("paths", {})
                        .get(p, {})
                        .get("get", {})
                        .get("parameters", [])
                    ]
                    for p in ("/api/news", "/api/breaking", "/api/search")
                },
            }
        except Exception as exc:
            report["providers"]["openapi"] = {
                "status": "UNAVAILABLE",
                "error_type": type(exc).__name__,
            }
        try:
            chain, block = await asyncio.gather(
                exchange.rpc("eth_chainId", []), exchange.rpc("eth_blockNumber", [])
            )
            report["providers"]["hsk_rpc"] = {
                "status": "AVAILABLE" if int(chain, 16) == 177 else "CHAIN_MISMATCH",
                "source": exchange.rpc_url,
                "chain_id": int(chain, 16),
                "block": int(block, 16),
            }
        except Exception as exc:
            report["providers"]["hsk_rpc"] = {
                "status": "UNAVAILABLE",
                "source": exchange.rpc_url,
                "error_type": type(exc).__name__,
            }
        report["hsk_live_blockers"] = exchange.missing
        target = Path(output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
    finally:
        await providers.close()
        await exchange.close()
        store.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--network",
        action="store_true",
        help="Explicitly permit public read-only HTTP/RPC requests",
    )
    parser.add_argument("--output", default="artifacts/provider-verification.json")
    args = parser.parse_args()
    if not args.network:
        parser.error("Pass --network to opt in; offline automated tests never contact providers")
    asyncio.run(verify(args.output))
