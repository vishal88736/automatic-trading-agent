"""Isolated product API with deterministic, explicitly labeled historical candles."""

import os
from datetime import timezone

from backend.backtesting import RULE_WARMUP_HOURS
from backend.data import FIXTURE_START, fixture_market
from backend.historical_data import HOUR
from backend.platform_db import DSN_ENV
from backend.platform_product_api import KEY_ENV, create_product_api


def history(symbol, start, end):
    first = start.astimezone(timezone.utc) - RULE_WARMUP_HOURS * HOUR
    count = int((end.astimezone(timezone.utc) - first) / HOUR)
    market = fixture_market(symbol, count=count)
    shift = first - FIXTURE_START
    market.candles = [
        candle.model_copy(
            update={"timestamp": candle.timestamp + shift, "closed_at": candle.closed_at + shift}
        )
        for candle in market.candles
    ]
    market.as_of = market.price_at = market.candles[-1].closed_at
    return market


def application():
    if os.environ.get("TERMINAL_TEST_RUN") != "1":
        raise RuntimeError("Use the isolated e2e configuration")
    return create_product_api(os.environ[DSN_ENV], os.environ[KEY_ENV], history_source=history)
