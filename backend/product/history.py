"""Load validated, bounded Coinbase hourly history for research."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Annotated

import httpx
from pydantic import AwareDatetime, Field, model_validator

from backend.backtesting import RULE_WARMUP_HOURS
from backend.data import ASSETS, parse_coinbase_candles
from backend.models import BacktestAssumptions, Market, RiskConfig, Token, now
from backend.product.spot_markets import product_id
from backend.settings import get_settings

HOUR = timedelta(hours=1)


class HistoricalBacktestRequest(BacktestAssumptions):
    version: Annotated[int, Field(ge=1, le=2**31 - 1)]
    start: AwareDatetime
    end: AwareDatetime
    risk: RiskConfig = Field(default_factory=RiskConfig)

    @model_validator(mode="after")
    def validate_window(self):
        for boundary in (self.start, self.end):
            utc = boundary.astimezone(timezone.utc)
            if utc.minute or utc.second or utc.microsecond:
                raise ValueError("Historical window must align to UTC hours")
        if self.end > now() or not timedelta(hours=80) <= self.end - self.start <= timedelta(
            days=14
        ):
            raise ValueError("Backtest window must be closed and between 80 hours and 14 days")
        return self


def load_candles(symbol: str, start: datetime, end: datetime, *, transport=None) -> Market:
    """Load an exact contiguous window plus required warm-up from the registered venue."""
    settings = get_settings().providers
    start = start.astimezone(timezone.utc) - RULE_WARMUP_HOURS * HOUR
    end = end.astimezone(timezone.utc)
    endpoint = f"{settings.market_base_url}/products/{product_id(symbol)}/candles"
    candles = []
    with httpx.Client(
        timeout=httpx.Timeout(3, connect=2),
        follow_redirects=False,
        transport=transport,
        headers={"User-Agent": "Krono-Backtest/0.1"},
    ) as client:
        cursor = start
        while cursor < end:
            # Keep each request below Coinbase's 300-candle limit and trim boundary extras.
            upper = min(end, cursor + 299 * HOUR)
            response = client.get(
                endpoint,
                params={
                    "granularity": "3600",
                    "start": cursor.isoformat(),
                    "end": upper.isoformat(),
                },
            )
            response.raise_for_status()
            bars = parse_coinbase_candles(response.json(parse_float=Decimal), end)
            candles.extend(bar for bar in bars if cursor <= bar.timestamp < upper)
            cursor = upper
    expected = int((end - start) / HOUR)
    if len(candles) != expected or any(
        candle.timestamp != start + index * HOUR for index, candle in enumerate(candles)
    ):
        raise ValueError("Coinbase candle history has missing hours in the requested window")
    return Market(
        asset=ASSETS.get(symbol) or Token(asset_id=symbol, symbol=symbol, name=symbol),
        candles=candles,
        source="coinbase_exchange",
        retrieved_at=now(),
        as_of=end,
        status="AVAILABLE",
    )
