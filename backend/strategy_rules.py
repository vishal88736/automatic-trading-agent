"""Versioned, declarative spot rules evaluated on closed reference candles."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from backend.models import Market, Model
from backend.strategies import indicators

Indicator = Literal[
    "price",
    "rsi",
    "ema_fast",
    "ema_slow",
    "sma50",
    "macd",
    "macd_signal",
    "atr",
    "bb_lower",
    "bb_upper",
    "bb_mid",
    "volume_ratio",
]
Threshold = Annotated[Decimal, Field(max_digits=30, decimal_places=12)]
Fraction = Annotated[Decimal, Field(gt=0, lt=1, decimal_places=6)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class Condition(Model):
    indicator: Indicator
    operator: Literal["lt", "lte", "gt", "gte", "crosses_above", "crosses_below"]
    threshold: Indicator | Threshold


class RuleGroup(Model):
    combine: Literal["all", "any"] = "all"
    conditions: tuple[Condition, ...] = Field(min_length=1, max_length=12)


class StrategyDefinition(Model):
    schema_version: Literal[1] = 1
    asset: Literal["BTC", "ETH", "SOL"]
    timeframe: Literal["1h"] = "1h"
    entry: RuleGroup
    exit: RuleGroup
    cash_fraction: Annotated[Decimal, Field(gt=0, le=1, decimal_places=6)]
    stop_loss: Fraction
    take_profit: Fraction | None = None
    trailing_stop: Fraction | None = None


class StrategyDraft(Model):
    name: Name
    description: str = Field(default="", max_length=2000)
    definition: StrategyDefinition


def _threshold(condition: Condition, values: dict) -> Decimal:
    if isinstance(condition.threshold, str):
        return Decimal(str(values[condition.threshold]))
    return condition.threshold


def _matches(condition: Condition, current: dict, previous: dict) -> bool:
    value = Decimal(str(current[condition.indicator]))
    threshold = _threshold(condition, current)
    match condition.operator:
        case "lt":
            return value < threshold
        case "lte":
            return value <= threshold
        case "gt":
            return value > threshold
        case "gte":
            return value >= threshold
        case "crosses_above":
            return value > threshold and (
                Decimal(str(previous[condition.indicator])) <= _threshold(condition, previous)
            )
        case "crosses_below":
            return value < threshold and (
                Decimal(str(previous[condition.indicator])) >= _threshold(condition, previous)
            )
    raise ValueError("Unknown strategy comparison")


def rule_signal(
    definition: StrategyDefinition, market: Market, *, holding: bool
) -> Literal["BUY", "SELL", "HOLD"]:
    """Evaluate one rule group. Execution and protective exits belong to the caller."""
    if market.asset.symbol != definition.asset or market.timeframe != definition.timeframe:
        raise ValueError("Market does not match the strategy asset and timeframe")
    if market.status not in {"AVAILABLE", "FIXTURE"} or not market.candles:
        raise ValueError("Strategy evaluation requires available closed candles")
    latest = market.candles[-1]
    if market.as_of is None or latest.closed_at > market.as_of:
        raise ValueError("A candle closes after the market observation")
    current = indicators(market)
    group = definition.exit if holding else definition.entry
    previous = {}
    if any(condition.operator.startswith("crosses_") for condition in group.conditions):
        earlier = market.candles[:-1]
        previous = indicators(
            market.model_copy(update={"candles": earlier, "as_of": earlier[-1].closed_at})
        )
    matches = (_matches(condition, current, previous) for condition in group.conditions)
    matched = all(matches) if group.combine == "all" else any(matches)
    if not matched:
        return "HOLD"
    return "SELL" if holding else "BUY"
