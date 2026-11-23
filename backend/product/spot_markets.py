"""Spot prices and instruments supported by the Coinbase paper venue."""

from threading import Lock
from time import monotonic
from typing import Annotated

import httpx
from pydantic import StringConstraints

from backend.settings import get_settings

Asset = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{2,20}$")]
FEATURED = get_settings().providers.featured_assets
FIXTURE_ASSETS = ("BTC", "ETH", "SOL", "ADA")

_lock = Lock()
_assets = tuple(get_settings().providers.assets)
_refresh_at = 0.0


def listed_assets(*, fixture: bool = False) -> tuple[str, ...]:
    if fixture:
        return FIXTURE_ASSETS
    global _assets, _refresh_at
    if monotonic() < _refresh_at or not _lock.acquire(blocking=False):
        return _assets
    try:
        if monotonic() < _refresh_at:
            return _assets
        try:
            response = httpx.get(f"{get_settings().providers.market_base_url}/products", timeout=3)
            response.raise_for_status()
            rows = response.json()
            if not isinstance(rows, list):
                raise ValueError("Invalid Coinbase catalog")
            symbols = set()
            for row in rows:
                if not isinstance(row, dict):
                    continue
                symbol = row.get("base_currency")
                if (
                    isinstance(symbol, str)
                    and 2 <= len(symbol) <= 20
                    and symbol.isascii()
                    and symbol.isalnum()
                    and symbol == symbol.upper()
                    and row.get("id") == f"{symbol}-USD"
                    and row.get("quote_currency") == "USD"
                    and row.get("status") == "online"
                    and not any(
                        row.get(flag)
                        for flag in (
                            "trading_disabled",
                            "cancel_only",
                            "post_only",
                            "limit_only",
                            "auction_mode",
                        )
                    )
                ):
                    symbols.add(symbol)
            if not symbols:
                raise ValueError("Empty Coinbase catalog")
            _assets = (
                *[symbol for symbol in FEATURED if symbol in symbols],
                *sorted(symbols.difference(FEATURED)),
            )
        except (httpx.HTTPError, ValueError):
            _refresh_at = monotonic() + 30
        else:
            _refresh_at = monotonic() + 300
        return _assets
    finally:
        _lock.release()


def product_id(symbol: str) -> str:
    settings = get_settings().providers
    if symbol in settings.assets:
        return settings.assets[symbol].product_id
    if symbol in listed_assets():
        return f"{symbol}-USD"
    raise ValueError(f"{symbol} is unavailable on the Coinbase USD spot market")
