"""Phase 2 preflight limits; the full autonomous policy follows with the Guard."""

from __future__ import annotations

import time
from decimal import Decimal

from pydantic import Field

from aegis.connectors.base import Quote
from aegis.data import StrictModel


class PaperLimits(StrictModel):
    max_trade_bps: int = Field(default=1000, ge=1, le=3000)
    max_price_impact_bps: Decimal = Field(default=Decimal(50), ge=0, le=100)
    min_pool_value_usdt: Decimal = Field(default=Decimal(10000), ge=1)
    max_quote_age_seconds: int = Field(default=20, ge=1, le=30)
    max_block_age_seconds: int = Field(default=90, ge=10, le=300)
    allowed_assets: tuple[str, ...] = ("WHSK", "USDT", "WETH", "WBTC")


class RiskRejected(ValueError):
    pass


class RiskEngine:
    def __init__(self, limits: PaperLimits | None = None):
        self.limits = limits or PaperLimits()

    def check(self, quote: Quote, marks: dict[str, Decimal]) -> None:
        now = int(time.time())
        if (
            now > quote.expires_at
            or now - quote.created_at > self.limits.max_quote_age_seconds
            or quote.created_at > now + 2
        ):
            raise RiskRejected("Quote is stale or has an invalid timestamp")
        if (
            now - quote.block_timestamp > self.limits.max_block_age_seconds
            or quote.block_timestamp > now + 10
        ):
            raise RiskRejected("Quote uses stale or future block data")
        if quote.price_impact_bps > self.limits.max_price_impact_bps:
            raise RiskRejected("Price impact exceeds the configured limit")
        if any(t.asset_id not in self.limits.allowed_assets for t in quote.route.tokens):
            raise RiskRejected("Route includes a token outside the allowed asset list")
        for state in quote.states:
            if not state.unlocked or state.liquidity_raw <= 0:
                raise RiskRejected("Pool has no active liquidity")
            p = state.pool
            value = (
                Decimal(state.balance0_raw)
                / 10**p.token0.decimals
                * marks[p.token0.address.lower()]
                + Decimal(state.balance1_raw)
                / 10**p.token1.decimals
                * marks[p.token1.address.lower()]
            )
            if value < self.limits.min_pool_value_usdt:
                raise RiskRejected("Pool value is below the minimum liquidity filter")
