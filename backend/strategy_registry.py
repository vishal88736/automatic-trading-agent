"""Common strategy contract over the preserved numerical/strategy implementation."""

from __future__ import annotations

from typing import Protocol

from pydantic import Field

from backend.models import Market, Model, NewsFeed, Signal, StrategyConfig
from backend.strategies import REGISTRY, evaluate, indicators


class StrategyEvaluation(Model):
    strategy_id: str
    signal: Signal
    direction: str
    market_suitability: str
    entry_conditions: str
    exit_conditions: str
    risk_reward: float | None = Field(default=None, ge=0)
    expected_holding_period: str
    supporting_indicators: dict
    rejection_reasons: list[str]
    assumption: str = "Rule confidence is not a probability of profit; no performance claim."


class TradingStrategy(Protocol):
    id: str
    name: str

    def evaluate(
        self, market: Market, news: NewsFeed, holding: bool = False, clock=None
    ) -> StrategyEvaluation: ...
    def validate(self, market: Market) -> list[str]: ...
    def get_configuration(self) -> StrategyConfig: ...


class RuleStrategy:
    def __init__(self, identifier: str, configuration: StrategyConfig):
        if identifier not in REGISTRY:
            raise ValueError("Unregistered approved strategy")
        self.id, self.name, self.config = identifier, REGISTRY[identifier]["name"], configuration

    def get_configuration(self):
        return self.config.model_copy(deep=True)

    def validate(self, market):
        if market.status not in {"AVAILABLE", "FIXTURE"}:
            return ["Market source is unavailable or stale"]
        try:
            indicators(market)
            return []
        except ValueError as exc:
            return [str(exc)]

    def evaluate(self, market, news, holding=False, clock=None):
        signal = evaluate(self.id, market, news, self.config, holding, clock)
        invalid = self.validate(market)
        measured = indicators(market) if not invalid else {}
        return StrategyEvaluation(
            strategy_id=self.id,
            signal=signal,
            direction="LONG"
            if signal.signal == "BUY"
            else "EXIT_OWNED_SPOT"
            if signal.signal == "SELL"
            else "FLAT",
            market_suitability=REGISTRY[self.id]["regime"],
            entry_conditions=REGISTRY[self.id]["entry"],
            exit_conditions=REGISTRY[self.id]["exit"],
            risk_reward=None,
            expected_holding_period="Hourly observations; variable holding period, managed by the recorded exit policy",
            supporting_indicators=measured,
            rejection_reasons=invalid + signal.risk_flags,
        )


def builtins(configurations: dict[str, StrategyConfig]) -> list[TradingStrategy]:
    return [
        RuleStrategy(identifier, configurations.get(identifier, StrategyConfig(enabled=False)))
        for identifier in REGISTRY
    ]
