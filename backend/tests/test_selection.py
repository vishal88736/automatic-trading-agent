from datetime import timedelta
from decimal import Decimal

from backend.data import fixture_market, fixture_news
from backend.models import StrategyConfig, now
from backend.selection import SelectionConfig, rank_strategies
from backend.strategies import REGISTRY, evaluate


def signals(market):
    return [evaluate(s, market, fixture_news(), StrategyConfig()) for s in REGISTRY]


def test_exactly_five_builtins_and_adaptive_measurements():
    assert set(REGISTRY) == {
        "momentum_v1",
        "mean_reversion_v1",
        "trend_following_v1",
        "breakout_v1",
        "spread_research_v1",
    }
    market = fixture_market("BTC")
    first = rank_strategies(market, fixture_news(), signals(market), SelectionConfig())
    changed = market.model_copy(deep=True)
    for index, bar in enumerate(changed.candles):
        price = Decimal("70000") + Decimal(str(15 * ((index % 10) - 5)))
        changed.candles[index] = bar.model_copy(
            update={
                "open": price,
                "high": price + 10,
                "low": price - 10,
                "close": price,
                "volume": Decimal("100"),
            }
        )
    changed.price = changed.candles[-1].close
    second = rank_strategies(changed, fixture_news(), signals(changed), SelectionConfig())
    assert first["features"] != second["features"]
    assert first["rankings"] != second["rankings"]
    assert first["selected"] != second["selected"]
    arbitrage = next(r for r in first["rankings"] if r["strategy_id"] == "spread_research_v1")
    assert not arbitrage["eligible"]
    assert all(not r["performance_available"] for r in first["rankings"])


def test_selector_cooldown_disabled_data_and_llm_cannot_enable_arbitrage():
    market = fixture_market("BTC")
    current = now()
    ranking = rank_strategies(
        market,
        fixture_news(),
        signals(market),
        SelectionConfig(),
        clock=current,
        contextual_advice={"spread_research_v1": 1},
    )
    assert "spread_research_v1" not in ranking["selected"]
    prior = {
        "selected": ["trend_following_v1"],
        "selected_at": (current - timedelta(seconds=30)).isoformat(),
    }
    held = rank_strategies(
        market, fixture_news(), signals(market), SelectionConfig(), previous=prior, clock=current
    )
    assert held["selected"] == prior["selected"]
    disabled = [
        evaluate(s, market, fixture_news(), StrategyConfig(enabled=False)) for s in REGISTRY
    ]
    assert rank_strategies(market, fixture_news(), disabled, SelectionConfig())["selected"] == []
    market.candles = market.candles[:20]
    assert not rank_strategies(market, fixture_news(), signals(market), SelectionConfig())[
        "selected"
    ]


def test_past_only_breakout_and_inventory_exit():
    market = fixture_market("BTC")
    config = StrategyConfig(volume_ratio=0.8, breakout_atr_buffer=0)
    market.candles[-1].close = market.candles[-1].high
    signal = evaluate("breakout_v1", market, fixture_news(), config)
    assert signal.signal in {"BUY", "HOLD"}
    assert signal.stop_price < market.price
    weak = fixture_market("ETH")
    weak.candles[-1].close = weak.candles[-1].low
    assert evaluate("trend_following_v1", weak, fixture_news(), config, holding=True).signal in {
        "SELL",
        "HOLD",
    }
