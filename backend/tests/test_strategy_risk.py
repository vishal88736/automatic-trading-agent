from datetime import timedelta
from decimal import Decimal

import pytest

from backend.data import fixture_market, fixture_news
from backend.exchanges import SimulationAdapter
from backend.models import Mode, Proposal, RiskConfig, Signal, StrategyConfig, now
from backend.risk import assess, validate_quote
from backend.strategies import evaluate, indicators

D = Decimal


def proposal(notional="100", side="BUY"):
    market = fixture_market("BTC")
    return Proposal(id="proposal-test", asset=market.asset, side=side, strategy_ids=["momentum_v1"], signal_at=now(), expires_at=now() + timedelta(minutes=2), evidence=["synthetic_fixture_v1"], rationale="Validated momentum filters", exit_policy="Exit below ATR stop or EMA invalidation.", stop_price=D("70000"), notional=D(notional), reference_price=market.price, expected_costs=D("0.2"), market_source=market.source, market_as_of=market.as_of, candle_count=len(market.candles), mode=Mode.SIMULATION, config_versions={"risk": 1, "momentum_v1": 1})


def portfolio(**overrides):
    return {"equity": "10000", "cash": "10000", "exposure": "0", "asset_values": {}, "positions": [], "daily_return": "0", "drawdown": "0", "valuation_complete": True, **overrides}


def test_real_strategy_rules_and_insufficient_history():
    market = fixture_market("BTC")
    signal = evaluate("momentum_v1", market, fixture_news(), StrategyConfig())
    assert signal.signal == "BUY" and signal.entry_conditions_met
    assert signal.stop_price < market.price
    assert evaluate("momentum_v1", market, fixture_news(), StrategyConfig(enabled=False)).signal == "HOLD"
    assert evaluate("momentum_v1", fixture_market("BTC", 20), fixture_news(), StrategyConfig()).risk_flags == ["INSUFFICIENT_HISTORY"]
    assert evaluate("spread_research_v1", market, fixture_news(), StrategyConfig()).signal == "HOLD"


def test_news_requires_corroboration_market_confirmation_and_availability():
    market, news = fixture_market("BTC"), fixture_news()
    assert evaluate("news_aware_v1", market, news, StrategyConfig()).signal == "BUY"
    news.articles = news.articles[:1]
    assert evaluate("news_aware_v1", market, news, StrategyConfig()).signal == "HOLD"
    news = fixture_news()
    for article in news.articles:
        article.available_at = market.as_of + timedelta(seconds=1)
    assert evaluate("news_aware_v1", market, news, StrategyConfig()).signal == "HOLD"


def test_indicator_values_and_duplicate_candles():
    market = fixture_market("BTC")
    result = indicators(market)
    assert 0 <= result["rsi"] <= 100 and result["atr"] > 0
    assert result["bb_lower"] < result["bb_mid"] < result["bb_upper"]
    market.candles[-1] = market.candles[-2]
    with pytest.raises(ValueError, match="unique"):
        indicators(market)


def test_exit_rules_do_not_short():
    market = fixture_market("ETH")
    config = StrategyConfig(rsi_exit=50)
    signal = evaluate("momentum_v1", market, fixture_news(), config, holding=True)
    assert signal.signal in {"SELL", "HOLD"}
    assert evaluate("mean_reversion_v1", fixture_market("BTC"), fixture_news(), StrategyConfig(), holding=True).signal == "SELL"
    assert evaluate("mean_reversion_v1", fixture_market("BTC"), fixture_news(), StrategyConfig(), holding=False).signal == "HOLD"


def test_sizing_reduces_and_hard_limits_validate():
    decision = assess(proposal("500"), portfolio(), RiskConfig(), 1)
    assert decision.verdict == "REDUCED" and decision.approved_notional == D("100")
    with pytest.raises(ValueError):
        RiskConfig(max_equity_per_trade=D("0.9"))
    with pytest.raises(ValueError):
        StrategyConfig(fast_period=30, slow_period=20)
    with pytest.raises(ValueError):
        Signal(strategy_id="x", symbol="BTC", signal="BUY", confidence=1.1, timestamp=now(), rationale="x")


@pytest.mark.parametrize("values,kwargs", [({"daily_return": "-0.04"}, {}), ({"drawdown": "0.11"}, {}), ({"cash": "0"}, {}), ({}, {"stopped": True}), ({}, {"pending": True}), ({}, {"recent_failures": 3}), ({"valuation_complete": False, "equity": None}, {}), ({}, {"last_trade": now()})])
def test_risk_enforces_independent_limits(values, kwargs):
    assert assess(proposal(), portfolio(**values), RiskConfig(), 1, **kwargs).verdict == "REJECTED"


def test_live_mode_and_stale_data_rejected():
    candidate = proposal().model_copy(update={"mode": Mode.LIVE, "market_source": "coinbase_exchange", "market_as_of": now() - timedelta(days=1)})
    result = assess(candidate, portfolio(), RiskConfig(), 1)
    assert result.verdict == "REJECTED"
    assert {c.code for c in result.checks if not c.passed} >= {"SUPPORTED_MODE", "TOKEN_IDENTITY", "MARKET_FRESHNESS"}


async def test_quote_validation_and_expiration():
    candidate, config = proposal(), RiskConfig()
    risk = assess(candidate, portfolio(), config, 1)
    quote = await SimulationAdapter().quote(candidate, risk.approved_notional)
    assert validate_quote(quote, candidate, risk, config) == []
    assert quote.minimum_output <= quote.output_amount and quote.minimum_output > 0
    assert validate_quote(quote, candidate, risk, config, clock=now() + timedelta(seconds=31))
    quote.input_amount = D("999")
    quote.chain_id = 177
    quote.slippage_bps = 500
    errors = validate_quote(quote, candidate, risk, config)
    assert "Unexpected input amount" in errors and "Chain mismatch" in errors and "Slippage ceiling exceeded" in errors
