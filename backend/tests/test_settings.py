from decimal import Decimal

import pytest

from backend.settings import RuntimeSettings, get_settings


def test_runtime_configuration_is_validated_and_identity_cannot_be_aliased():
    config = get_settings().model_dump(mode="json")
    assert len(get_settings().fingerprint) == 64
    for field, value in [("market_base_url", "http://localhost/private"), ("read_attempts", 99)]:
        candidate = {**config, "providers": {**config["providers"], field: value}}
        with pytest.raises(ValueError):
            RuntimeSettings.model_validate(candidate)
    config["providers"]["assets"]["BTC"]["product_id"] = "ETH-USD"
    with pytest.raises(ValueError, match="identity"):
        RuntimeSettings.model_validate(config)


async def test_simulation_costs_and_backtest_capital_follow_configuration():
    from backend.backtesting import backtest
    from backend.data import fixture_market, fixture_news
    from backend.exchanges import SimulationAdapter
    from backend.models import BacktestRequest, RiskConfig, StrategyConfig
    from backend.tests.test_strategy_risk import proposal

    settings = get_settings().simulation.model_copy(
        update={"fee_bps": 20, "slippage_bps": 15, "liquidity_usd": Decimal("2000000")}
    )
    adapter = SimulationAdapter(settings)
    quote = await adapter.quote(proposal(), Decimal("100"))
    assert quote.trading_fee_usd == Decimal("0.2")
    assert quote.slippage_bps == 15 and quote.liquidity_usd == Decimal("2000000")
    assert "20 bps" in quote.route[-1]
    assert adapter.estimate_costs(Decimal("100"), "BUY") > quote.trading_fee_usd
    result = backtest(
        fixture_market("BTC"),
        fixture_news(),
        BacktestRequest(initial_equity=5000),
        StrategyConfig(),
        RiskConfig(),
    )
    assert result["in_sample"]["starting_equity"] == "5000"
    assert result["out_of_sample"]["starting_equity"] == "5000"
    assert (
        Decimal(result["out_of_sample"]["total_return"])
        == Decimal(result["out_of_sample"]["ending_equity"]) / 5000 - 1
    )


def test_accounting_retains_history_beyond_display_limits():
    from backend.models import now
    from backend.portfolio import Portfolio
    from backend.storage import Store, encode

    store = Store(":memory:")
    try:
        at = now().isoformat()
        store.snapshot({"at": at, "equity": "20000"})
        payload = encode({"at": at, "equity": "10000"})
        with store.transaction():
            store.db.executemany(
                "INSERT INTO snapshots(at,payload) VALUES (?,?)",
                ((at, payload) for _ in range(100000)),
            )
        view = Portfolio(store).view({})
        assert view["highwater_equity"] == Decimal(20000)
        assert view["drawdown"] == Decimal("0.5")
    finally:
        store.close()


def test_nested_accounting_configuration_updates_remain_atomic():
    from backend.storage import Store

    store = Store(":memory:")
    try:
        with pytest.raises(ValueError, match="abort outer"):
            with store.transaction():
                store.update_config("portfolio_highwater", {"equity": "20000"})
                raise ValueError("abort outer")
        assert store.config("portfolio_highwater") == (None, 0)
        assert store.history("audit")["total"] == 0
        with store.transaction():
            store.update_config("kept", 1)
            try:
                with store.transaction():
                    store.update_config("rolled_back", 1)
                    raise ValueError("inner only")
            except ValueError:
                pass
        assert store.config("kept")[0] == 1
        assert store.config("rolled_back") == (None, 0)
    finally:
        store.close()
