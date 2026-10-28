from datetime import timedelta
from decimal import Decimal

import httpx
import pytest

from backend.analytics import aggregate, correlations
from backend.api import create_app
from backend.data import Providers, fixture_market
from backend.engine import Engine
from backend.exchanges import SimulationAdapter
from backend.models import RunRequest, SchedulerAction, now
from backend.risk import assess, validate_quote
from backend.storage import Store
from backend.tests.test_strategy_risk import portfolio, proposal


def test_complete_candle_aggregation_and_aligned_correlation():
    market = fixture_market("BTC")
    four_hour = aggregate(market, "4h")
    assert len(four_hour.candles) == 59
    assert four_hour.candles[0].open == market.candles[0].open
    assert four_hour.candles[0].close == market.candles[3].close
    assert four_hour.candles[0].volume == sum(c.volume for c in market.candles[:4])
    assert four_hour.candles[-1].closed_at <= market.candles[-1].closed_at
    daily = aggregate(market, "1d")
    assert len(daily.candles) == 9
    values = {s: fixture_market(s) for s in ("BTC", "ETH", "SOL")}
    result = correlations(values)
    assert result["status"] == "FIXTURE" and result["observations"] == 237
    assert result["matrix"]["BTC"]["BTC"] == 1.0
    values["ETH"].status = "STALE"
    assert correlations(values)["status"] == "UNAVAILABLE"


async def test_bad_quote_output_price_fees_and_deadline_rejected():
    candidate = proposal()
    config = __import__("backend.models", fromlist=["RiskConfig"]).RiskConfig()
    risk = assess(candidate, portfolio(), config, 1)
    quote = await SimulationAdapter().quote(candidate, risk.approved_notional)
    quote.output_amount = Decimal("0.00000001")
    quote.price = candidate.reference_price * 2
    quote.trading_fee_usd = Decimal("99")
    quote.deadline = now() + timedelta(days=1)
    errors = validate_quote(quote, candidate, risk, config)
    assert "Quote output, price and fee are inconsistent" in errors
    assert "Trading fee ceiling exceeded" in errors
    assert "Quoted price move exceeds declared slippage and impact" in errors
    assert "Transaction deadline exceeds the bounded authorization window" in errors


async def test_real_database_reopen_recovers_without_duplicate_submission(tmp_path):
    path = str(tmp_path / "reopen.sqlite3")
    store = Store(path)
    engine = Engine(store, Providers(store))
    run = await engine.run(RunRequest())
    intent = run["intent"]
    intent["state"] = "SUBMITTED"
    store.put("intents", intent["id"], intent, state="SUBMITTED", proposal_id=intent["proposal_id"])
    engine.control(SchedulerAction(action="start"))
    await engine.close()
    store.close()
    reopened = Store(path)
    recovered = Engine(reopened, Providers(reopened))
    recovered.recover()
    assert recovered.state()["state"] == "PAUSED"
    assert reopened.get("intents", intent["id"])["state"] == "RECONCILIATION_REQUIRED"
    assert reopened.history("ledger")["total"] == 0
    await recovered.close()
    reopened.close()


async def test_live_environment_does_not_enable_execution_and_chat_strategy_changes(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TERMINAL_MODE", "LIVE")
    app = create_app(str(tmp_path / "live-forbidden.sqlite3"), testing=True, api_token="test-token")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8787",
            headers={"Authorization": "Bearer test-token"},
        ) as client:
            status = (await client.get("/api/status")).json()
            assert status["mode"] == "SIMULATION" and not status["live_enabled"]
            result = (
                await client.post("/api/chat", json={"message": "Disable momentum strategy"})
            ).json()
            assert result["tool"] == "set_strategy_enabled" and not result["data"]["enabled"]
            strategies = (await client.get("/api/strategies")).json()
            assert not next(s for s in strategies["items"] if s["id"] == "momentum_v1")["config"][
                "enabled"
            ]
            scoring = (await client.get("/api/settings/news-scoring")).json()
            changed = await client.put(
                "/api/settings/news-scoring",
                json={
                    "expected_version": scoring["version"],
                    "config": {**scoring["config"], "maximum_confidence": 0.6},
                },
            )
            assert changed.status_code == 200 and changed.json()["version"] == 2
            assert "test-token" not in (await client.get("/api/status")).text


def test_scheduler_auto_simulation_requires_explicit_permission():
    store = Store(":memory:")
    engine = Engine(store, Providers(store))
    with pytest.raises(ValueError, match="acknowledgement"):
        engine.control(SchedulerAction(action="start", auto_simulate=True))
    assert not engine.state()["auto_simulate"]
    store.close()


def test_backtest_entry_bar_stop_and_opening_invalidation(monkeypatch):
    from backend.backtesting import backtest
    from backend.data import fixture_news
    from backend.models import BacktestRequest, Candle, RiskConfig, Signal, StrategyConfig

    market = fixture_market("BTC", 200)
    market.candles = [
        Candle(
            timestamp=c.timestamp,
            closed_at=c.closed_at,
            open=100,
            high=101,
            low=90 if i == 80 else 99,
            close=100,
            volume=100,
        )
        for i, c in enumerate(market.candles)
    ]

    def signal(strategy_id, history, news, config, holding=False, clock=None):
        return Signal(
            strategy_id=strategy_id,
            symbol="BTC",
            signal="HOLD" if holding else "BUY",
            confidence=0.5,
            timestamp=clock,
            rationale="Controlled order-fill fixture",
            stop_price=95,
        )

    monkeypatch.setattr("backend.backtesting.evaluate", signal)
    result = backtest(market, fixture_news(), BacktestRequest(), StrategyConfig(), RiskConfig())
    fills = result["in_sample"]["trades"]
    assert fills[0]["side"] == "BUY" and fills[1]["side"] == "SELL"
    assert "entry-bar ATR stop" in fills[1]["reason"] and Decimal(fills[1]["pnl"]) < 0
    bar = market.candles[80]
    market.candles[80] = Candle(
        timestamp=bar.timestamp,
        closed_at=bar.closed_at,
        open=90,
        high=101,
        low=89,
        close=100,
        volume=100,
    )
    invalidated = backtest(
        market, fixture_news(), BacktestRequest(), StrategyConfig(), RiskConfig()
    )
    assert invalidated["in_sample"]["trades"][0]["at"] == market.candles[81].timestamp.isoformat()


async def test_missing_marks_remain_null_and_block_risk():
    from backend.models import Authorize, Proposal

    store = Store(":memory:")
    engine = Engine(store, Providers(store))
    run = await engine.run(RunRequest())
    intent = run["intent"]
    await engine.authorize(
        Authorize(
            intent_id=intent["id"],
            quote_id=intent["quote"]["id"],
            acknowledgement="AUTHORIZE_SIMULATION",
        )
    )
    engine.markets["BTC"] = engine.markets["BTC"].model_copy(update={"status": "STALE"})
    state = engine.portfolio.view(engine.markets)
    assert state["equity"] is None and state["exposure"] is None
    assert state["drawdown"] is None and state["daily_return"] is None
    assert state["positions"][0]["mark"] is None and state["positions"][0]["value"] is None
    decision = engine.execution.decision(Proposal.model_validate(run["proposal"]))
    assert decision.verdict == "REJECTED"
    await engine.close()
    store.close()
