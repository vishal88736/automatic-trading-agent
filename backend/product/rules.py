"""Versioned, declarative spot rules evaluated on closed reference candles."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal, get_args

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
    "prior_high_20",
    "prior_low_20",
]
Operator = Literal["lt", "lte", "gt", "gte", "crosses_above", "crosses_below"]
Threshold = Annotated[Decimal, Field(max_digits=30, decimal_places=12)]
Fraction = Annotated[Decimal, Field(gt=0, lt=1, decimal_places=6)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class Condition(Model):
    indicator: Indicator
    operator: Operator
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


def authoring_options() -> dict:
    pairs = (
        ("RSI mean reversion", ("rsi", "lt", "30"), ("rsi", "gt", "65")),
        (
            "MACD crossover",
            ("macd", "crosses_above", "macd_signal"),
            ("macd", "crosses_below", "macd_signal"),
        ),
        (
            "EMA crossover",
            ("ema_fast", "crosses_above", "ema_slow"),
            ("ema_fast", "crosses_below", "ema_slow"),
        ),
        ("Bollinger mean reversion", ("price", "lt", "bb_lower"), ("price", "gte", "bb_mid")),
        ("20-bar breakout", ("price", "gt", "prior_high_20"), ("price", "lt", "prior_low_20")),
    )

    def group(rule):
        indicator, operator, threshold = rule
        return RuleGroup(
            conditions=(Condition(indicator=indicator, operator=operator, threshold=threshold),)
        )

    templates = [
        StrategyDraft(
            name=name,
            description="Editable hourly spot template",
            definition=StrategyDefinition(
                asset="BTC",
                entry=group(entry),
                exit=group(exit),
                cash_fraction=Decimal("0.02"),
                stop_loss=Decimal("0.04"),
            ),
        ).model_dump(mode="json")
        for name, entry, exit in pairs
    ]
    return {
        "assets": get_args(StrategyDefinition.model_fields["asset"].annotation),
        "timeframes": get_args(StrategyDefinition.model_fields["timeframe"].annotation),
        "indicators": get_args(Indicator),
        "operators": get_args(Operator),
        "templates": templates,
        "schema": StrategyDraft.model_json_schema(),
    }
