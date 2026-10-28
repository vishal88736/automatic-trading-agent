from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from enum import StrEnum
import re
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator


def now() -> datetime:
    return datetime.now(timezone.utc)


def uid() -> str:
    return str(uuid4())


Money = Annotated[Decimal, Field(ge=0, max_digits=38, decimal_places=18)]
Positive = Annotated[Decimal, Field(gt=0, max_digits=38, decimal_places=18)]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, validate_assignment=True)


class Mode(StrEnum):
    SIMULATION = "SIMULATION"
    PAPER = "PAPER"
    LIVE = "LIVE"


class Token(Model):
    asset_id: str = Field(pattern=r"^[A-Z0-9_]{2,20}$")
    symbol: str
    name: str
    chain_id: int | None = Field(default=None, gt=0)
    address: str | None = None
    decimals: int | None = Field(default=None, ge=0, le=36)
    verified: bool = False
    metadata_source: str | None = None
    kind: Literal["reference", "erc20", "native"] = "reference"

    @model_validator(mode="after")
    def identity(self):
        if self.address and not re.fullmatch(r"0x[0-9a-fA-F]{40}", self.address):
            raise ValueError("Token address must be a 20-byte EVM address")
        if self.address and int(self.address, 16) == 0:
            raise ValueError("Zero token address is invalid")
        if self.kind != "reference" and not self.chain_id:
            raise ValueError("On-chain tokens require a chain")
        if self.kind == "erc20" and not self.address:
            raise ValueError("ERC-20 tokens require an address")
        if self.verified and (
            self.kind == "reference" or self.decimals is None or not self.metadata_source
        ):
            raise ValueError("Verified token requires on-chain identity, decimals and provenance")
        return self


class Candle(Model):
    timestamp: AwareDatetime
    closed_at: AwareDatetime
    open: Positive
    high: Positive
    low: Positive
    close: Positive
    volume: Money

    @model_validator(mode="after")
    def valid_bar(self):
        if self.closed_at <= self.timestamp:
            raise ValueError("Candle close must follow open time")
        if self.low > min(self.open, self.close) or self.high < max(self.open, self.close):
            raise ValueError("OHLC prices violate high/low bounds")
        return self


class Market(Model):
    asset: Token
    candles: list[Candle] = Field(default_factory=list)
    source: str
    retrieved_at: AwareDatetime
    as_of: AwareDatetime | None = None
    status: Literal["AVAILABLE", "STALE", "UNAVAILABLE", "FIXTURE"]
    timeframe: str = "1h"
    liquidity_usd: Money | None = None
    limitation: str | None = None
    price: Positive | None = None
    price_at: AwareDatetime | None = None


class Article(Model):
    id: str
    title: str = Field(min_length=1, max_length=1000)
    publisher: str
    url: str
    published_at: AwareDatetime | None = None
    retrieved_at: AwareDatetime
    available_at: AwareDatetime
    assets: list[str] = Field(default_factory=list)
    category: str = "general"
    sentiment: Literal["bullish", "bearish", "neutral", "uncertain"] = "uncertain"
    confidence: float = Field(default=0, ge=0, le=1)
    relevance: float = Field(default=0, ge=0, le=1)
    urgency: Literal["normal", "breaking", "unknown"] = "normal"
    summary: str = ""
    summary_kind: Literal["publisher_excerpt", "model_interpretation", "fixture"] = "publisher_excerpt"
    fixture: bool = False
    stale: bool = False
    actionable_content: bool = True
    limitations: list[str] = Field(default_factory=list)


class NewsFeed(Model):
    articles: list[Article] = Field(default_factory=list)
    status: Literal["AVAILABLE", "STALE", "UNAVAILABLE", "FIXTURE"]
    source: str
    retrieved_at: AwareDatetime
    error: str | None = None


class StrategyConfig(Model):
    enabled: bool = True
    assets: list[Literal["BTC", "ETH", "SOL"]] = Field(default_factory=lambda: ["BTC", "ETH", "SOL"])
    fast_period: int = Field(default=12, ge=5, le=30)
    slow_period: int = Field(default=26, ge=20, le=60)
    rsi_entry: float = Field(default=68, ge=45, le=75)
    rsi_exit: float = Field(default=40, ge=20, le=50)
    volume_ratio: float = Field(default=1.05, ge=0.8, le=3)
    reversion_rsi: float = Field(default=32, ge=15, le=40)
    max_trend_distance: float = Field(default=0.025, ge=0.005, le=0.05)
    news_min_sources: int = Field(default=2, ge=2, le=5)
    news_max_age_minutes: int = Field(default=120, ge=15, le=360)
    cooldown_seconds: int = Field(default=300, ge=30, le=86400)
    stop_atr_multiple: float = Field(default=2, ge=1, le=5)

    @model_validator(mode="after")
    def periods(self):
        if self.fast_period >= self.slow_period:
            raise ValueError("Fast period must be smaller than slow period")
        if not self.assets or len(set(self.assets)) != len(self.assets):
            raise ValueError("Select a nonempty unique asset list")
        return self


class Signal(Model):
    strategy_id: str
    symbol: str
    chain: int | None = None
    signal: Literal["BUY", "HOLD", "SELL", "REJECTED"]
    confidence: float = Field(ge=0, le=1)
    entry_conditions_met: bool = False
    exit_conditions_met: bool = False
    evidence: list[str] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)
    timestamp: AwareDatetime
    rationale: str
    stop_price: Positive | None = None


class RiskConfig(Model):
    max_trade_notional: Positive = Field(default=Decimal("250"), le=1000)
    max_equity_per_trade: Positive = Field(default=Decimal("0.01"), le=Decimal("0.05"))
    max_asset_exposure: Positive = Field(default=Decimal("0.10"), le=Decimal("0.25"))
    max_aggregate_exposure: Positive = Field(default=Decimal("0.30"), le=Decimal("0.60"))
    max_daily_loss: Positive = Field(default=Decimal("0.03"), le=Decimal("0.05"))
    max_drawdown: Positive = Field(default=Decimal("0.10"), le=Decimal("0.20"))
    max_slippage_bps: int = Field(default=50, ge=1, le=100)
    max_price_impact: Positive = Field(default=Decimal("0.005"), le=Decimal("0.02"))
    min_liquidity_usd: Positive = Field(default=Decimal("50000"), ge=10000)
    max_network_fee: Positive = Field(default=Decimal("2"), le=10)
    cooldown_seconds: int = Field(default=60, ge=30, le=86400)
    max_positions: int = Field(default=5, ge=1, le=10)
    max_quote_age_seconds: int = Field(default=20, ge=1, le=30)
    max_market_age_seconds: int = Field(default=7200, ge=3600, le=14400)
    max_recent_failures: int = Field(default=3, ge=1, le=5)
    failure_cooldown_seconds: int = Field(default=300, ge=60, le=3600)
    emergency_policy: Literal["HOLD_AND_REVIEW"] = "HOLD_AND_REVIEW"


class Proposal(Model):
    id: str
    asset: Token
    side: Literal["BUY", "SELL"]
    strategy_ids: list[str] = Field(min_length=1)
    signal_at: AwareDatetime
    expires_at: AwareDatetime
    evidence: list[str]
    rationale: str
    exit_policy: str = Field(min_length=10)
    stop_price: Positive
    notional: Positive
    reference_price: Positive
    expected_costs: Money
    market_source: str
    market_as_of: AwareDatetime
    candle_count: int = Field(ge=0)
    mode: Mode
    config_versions: dict[str, int]
    risk_result: dict[str, Any] | None = None


class Check(Model):
    code: str
    passed: bool
    actual: str
    limit: str
    reason: str


class RiskDecision(Model):
    id: str = Field(default_factory=uid)
    proposal_id: str
    verdict: Literal["APPROVED", "REDUCED", "REJECTED"]
    requested_notional: Positive
    approved_notional: Money
    checks: list[Check]
    reasons: list[str]
    version: int
    timestamp: AwareDatetime = Field(default_factory=now)


class Quote(Model):
    id: str = Field(default_factory=uid)
    proposal_id: str
    mode: Mode
    chain_id: int | None
    input_token: Token
    output_token: Token
    input_amount: Positive
    output_amount: Positive
    minimum_output: Positive
    notional: Positive
    price: Positive
    slippage_bps: int = Field(ge=0, le=10000)
    price_impact: Money
    network_fee_usd: Money
    trading_fee_usd: Money
    liquidity_usd: Money | None
    created_at: AwareDatetime
    expires_at: AwareDatetime
    deadline: AwareDatetime
    source: str
    route: list[str]
    wallet: str | None = None


class RunRequest(Model):
    symbol: Literal["BTC", "ETH", "SOL"] = "BTC"
    notional: Positive = Field(default=Decimal("100"), le=10000)


class VersionedStrategy(Model):
    expected_version: int = Field(ge=1)
    config: StrategyConfig


class VersionedRisk(Model):
    expected_version: int = Field(ge=1)
    config: RiskConfig


class Authorize(Model):
    intent_id: str
    quote_id: str
    acknowledgement: Literal["AUTHORIZE_SIMULATION"]


class SchedulerAction(Model):
    action: Literal["start", "pause", "resume", "stop", "shutdown", "emergency_stop", "clear_emergency"]
    interval_seconds: int = Field(default=300, ge=30, le=86400)
    auto_simulate: bool = False
    acknowledge: bool = False


class ChatRequest(Model):
    message: str = Field(min_length=1, max_length=2000)


class BacktestRequest(Model):
    symbol: Literal["BTC", "ETH", "SOL"] = "BTC"
    strategy_id: Literal["momentum_v1", "mean_reversion_v1", "news_aware_v1"] = "momentum_v1"
    fee_bps: int = Field(default=10, ge=0, le=100)
    slippage_bps: int = Field(default=10, ge=0, le=100)
    holdout_fraction: float = Field(default=0.3, ge=0.2, le=0.5)
