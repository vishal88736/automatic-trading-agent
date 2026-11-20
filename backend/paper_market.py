"""Timestamped Coinbase spot inputs for the paper ledger."""

import httpx

from backend.data import parse_time
from backend.paper_execution import PaperQuote
from backend.settings import get_settings


def load_quotes(assets: set[str]) -> dict[str, PaperQuote]:
    settings = get_settings().providers
    quotes = {}
    if not assets:
        return quotes
    with httpx.Client(timeout=1.8, follow_redirects=False) as client:
        for asset in sorted(assets & settings.assets.keys()):
            product = settings.assets[asset].product_id
            try:
                response = client.get(f"{settings.market_base_url}/products/{product}/ticker")
                response.raise_for_status()
                payload = response.json()
                if isinstance(payload, dict):
                    quotes[asset] = PaperQuote(
                        asset=asset,
                        price=payload.get("price"),
                        observed_at=parse_time(payload.get("time")),
                        source="coinbase_exchange",
                    )
            except (ValueError, httpx.HTTPError):
                # Missing marks remain unavailable, so the engine can fail closed or keep waiting.
                continue
    return quotes
