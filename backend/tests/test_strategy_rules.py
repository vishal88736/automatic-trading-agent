from decimal import Decimal

import pytest
from pydantic import ValidationError

from backend.data import fixture_market
from backend.product.rules import StrategyDefinition, rule_signal
from backend.strategies import indicators


def rule(indicator, operator, threshold):
    return {"indicator": indicator, "operator": operator, "threshold": threshold}


def definition(**overrides):
    return StrategyDefinition.model_validate(
        {
            "asset": "BTC",
            "entry": {"conditions": [rule("price", "gt", "1")]},
            "exit": {"conditions": [rule("rsi", "gt", "80")]},
            "cash_fraction": "0.02",
            "stop_loss": "0.03",
            **overrides,
        }
    )


def test_rule_groups_select_entry_or_exit():
    market = fixture_market("BTC")
    strategy = definition(
        entry={
            "combine": "any",
            "conditions": [rule("macd", "gt", "1000000"), rule("price", "gt", "1")],
        },
        exit={"combine": "all", "conditions": [rule("price", "gt", "1"), rule("rsi", "gt", "100")]},
    )
    assert rule_signal(strategy, market, holding=False) == "BUY"
    assert rule_signal(strategy, market, holding=True) == "HOLD"
    assert strategy.model_dump(mode="json")["cash_fraction"] == "0.02"


def test_crossing_compares_consecutive_closed_bars():
    market = fixture_market("BTC", count=81)
    prior = market.model_copy(
        update={"candles": market.candles[:-1], "as_of": market.candles[-2].closed_at}
    )
    before = Decimal(str(indicators(prior)["rsi"]))
    after = Decimal(str(indicators(market)["rsi"]))
    assert before != after
    direction = "crosses_above" if before < after else "crosses_below"
    threshold = ((before + after) / 2).quantize(Decimal("0.000001"))
    strategy = definition(exit={"conditions": [rule("rsi", direction, threshold)]})
    assert rule_signal(strategy, market, holding=True) == "SELL"
    with pytest.raises(ValueError, match="80 valid closed candles"):
        rule_signal(strategy, prior, holding=True)
    market.as_of = market.candles[-2].closed_at
    with pytest.raises(ValueError, match="after the market observation"):
        rule_signal(strategy, market, holding=True)


def test_indicator_operand_is_evaluated_at_the_same_bar():
    market = fixture_market("BTC")
    values = indicators(market)
    strategy = definition(entry={"conditions": [rule("ema_fast", "gt", "ema_slow")]})
    result = "BUY" if values["ema_fast"] > values["ema_slow"] else "HOLD"
    assert rule_signal(strategy, market, holding=False) == result
    with pytest.raises(ValueError, match="does not match"):
        rule_signal(strategy, fixture_market("ETH"), holding=False)


@pytest.mark.parametrize(
    "invalid",
    [
        {"timeframe": "5m"},
        {"cash_fraction": "1.01"},
        {"stop_loss": "-0.01"},
        {"entry": {"conditions": []}},
        {"entry": {"conditions": [rule("rsi", "eval", "30")]}},
        {"entry": {"conditions": [rule("rsi", "lt", "print('invalid')")]}},
    ],
)
def test_unsupported_inputs_fail_validation(invalid):
    with pytest.raises(ValidationError):
        definition(**invalid)


def test_all_authoring_templates_use_the_runtime_strategy_schema():
    from backend.product.rules import StrategyDraft, authoring_options

    choice = authoring_options()
    assert len(choice["templates"]) == 5
    market = fixture_market("BTC")
    for template in choice["templates"]:
        draft = StrategyDraft.model_validate(template)
        assert rule_signal(draft.definition, market, holding=False) in {"BUY", "HOLD"}
        assert rule_signal(draft.definition, market, holding=True) in {"SELL", "HOLD"}
