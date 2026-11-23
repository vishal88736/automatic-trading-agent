"""Isolated product API with deterministic, explicitly labeled historical candles."""

import os
from datetime import timezone

from backend.backtesting import RULE_WARMUP_HOURS
from backend.data import FIXTURE_START, fixture_market
from backend.models import now
from backend.product.api import KEY_ENV, create_product_api
from backend.product.database import DSN_ENV
from backend.product.execution import PaperQuote
from backend.product.history import HOUR


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


def quotes(assets):
    prices = {"BTC": "50000", "ETH": "2500", "SOL": "130", "ADA": "0.60"}
    at = now()
    return {
        asset: PaperQuote(asset=asset, price=prices[asset], observed_at=at, source="fixture")
        for asset in assets
    }


def application():
    if os.environ.get("TERMINAL_TEST_RUN") != "1":
        raise RuntimeError("Use the isolated e2e configuration")
    return create_product_api(
        os.environ[DSN_ENV],
        os.environ[KEY_ENV],
        history_source=history,
        quote_source=quotes,
        fixture_feeds=True,
    )
