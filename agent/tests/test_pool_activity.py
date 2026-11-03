"""Entries need a pool that trades, and one strategy signal holds at most one position."""

from __future__ import annotations

import time
from decimal import Decimal

import pytest

from aegis.risk.engine import RiskRejected
from aegis.risk.policy import ALL_STRATEGIES, DEFAULT_STRATEGIES, AgentParams
from aegis.strategy.activity import pool_activity
from agent.tests.test_library import library_snapshot, start
from agent.tests.test_runtime import runtime as runtime  # noqa: F401 - pytest fixture

NOW = 1_800_000_000


def obs(at, price):
    return {"observed_at": at, "markets": {"WBTC": {"price": price}}}


def test_activity_classifies_active_inactive_and_warming_pools():
    window = 900
    active = pool_activity(
        [obs(NOW - 600, "1"), obs(NOW - 300, "2")], {"WBTC": {"price": "2"}}, NOW, window
    )
    assert active["WBTC"]["status"] == "active" and active["WBTC"]["reason"] is None
    assert active["WBTC"]["last_change_at"] == NOW - 300
    inactive = pool_activity(
        [obs(NOW - 900, "1"), obs(NOW - 450, "1")], {"WBTC": {"price": "1"}}, NOW, window
    )
    assert inactive["WBTC"]["status"] == "inactive"
    assert "has not moved for at least" in inactive["WBTC"]["reason"]
    warming = pool_activity([obs(NOW - 120, "1")], {"WBTC": {"price": "1"}}, NOW, window)
    assert warming["WBTC"]["status"] == "warming" and "not confirmed" in warming["WBTC"]["reason"]
    # Observations older than the window are not evidence of current activity.
    stale = pool_activity(
        [obs(NOW - 5000, "9"), obs(NOW - 900, "1")], {"WBTC": {"price": "1"}}, NOW, window
    )
    assert stale["WBTC"]["status"] == "inactive"


def test_static_pool_blocks_entries_but_never_exits(runtime):
    runtime.set_params({"target_assets": ["WHSK"]}, runtime.version)
    runtime.tick()
    # The same mid recorded 20 minutes ago: nobody has swapped in this pool since.
    runtime.ledger.observe(
        {**runtime.latest, "block_hash": "old", "observed_at": int(time.time()) - 1200}
    )
    runtime.control("resume", acknowledgement="AUTHORIZE_PAPER_AUTOMATION")
    state = runtime.tick()
    assert state["pool_activity"]["WHSK"]["status"] == "inactive"
    stable, whsk = runtime.ledger.stable, runtime.live.tokens["WHSK"]
    with pytest.raises(RiskRejected, match="has not moved"):
        runtime.gateway.execute("manual-entry", stable, whsk, 10**stable.decimals)
    assert runtime.ledger.fills() == []
    skipped = [d for d in state["decisions"] if d["status"] == "signal_skipped"]
    assert skipped, "mean reversion records why it did not enter"


async def test_one_open_position_per_library_strategy(runtime):
    start(runtime)
    first = runtime.tick(library=await library_snapshot(runtime))
    assert [f["quote"]["route"]["tokens"][-1]["asset_id"] for f in first["fills"]] == ["WBTC"]
    snapshot = await library_snapshot(runtime)
    btc = next(s for s in snapshot.signals if s.strategy_id == "momentum_v1" and s.symbol == "BTC")
    eth_price = Decimal(runtime.view()["markets"]["WETH"]["price"])
    # The same momentum signal family now also says BUY for the correlated asset.
    eth = btc.model_copy(
        update={
            "symbol": "ETH",
            "action": "BUY",
            "reason": "EMA, MACD, RSI and volume confirmed.",
            "reference_price": eth_price,
            "stop_price": eth_price * Decimal("0.99"),
            "candle_hash": "eth-" + btc.candle_hash[4:],
        }
    )
    snapshot = snapshot.model_copy(
        update={
            "signals": [
                eth if (s.strategy_id, s.symbol) == ("momentum_v1", "ETH") else s
                for s in snapshot.signals
            ]
        }
    )
    second = runtime.tick(library=snapshot)
    assert len(second["fills"]) == 1
    blocked = next(
        s
        for s in second["library_signals"]
        if s["strategy_id"] == "momentum_v1" and s["asset"] == "WETH"
    )
    assert blocked["execution_status"] == "BLOCKED", (blocked["action"], blocked["reason"])
    assert "already holds WBTC" in blocked["reason"]


def test_defaults_leave_out_strategies_that_cannot_trade():
    assert "arbitrage" not in DEFAULT_STRATEGIES and "spread_research_v1" not in DEFAULT_STRATEGIES
    assert set(DEFAULT_STRATEGIES) < set(ALL_STRATEGIES)
    assert AgentParams().active_strategies == DEFAULT_STRATEGIES
    # Explicitly enabling them is still allowed.
    assert "arbitrage" in AgentParams(active_strategies=ALL_STRATEGIES).active_strategies


def test_holding_hold_reason_says_why():
    from backend.data import fixture_market
    from backend.models import NewsFeed, StrategyConfig, now
    from backend.strategies import evaluate

    market = fixture_market("BTC")
    news = NewsFeed(articles=[], status="UNAVAILABLE", source="test", retrieved_at=now())
    for strategy_id in ("momentum_v1", "trend_following_v1", "breakout_v1", "mean_reversion_v1"):
        config = StrategyConfig(enabled=True)
        fresh = evaluate(strategy_id, market, news, config, holding=False)
        held = evaluate(strategy_id, market, news, config, holding=True)
        if fresh.signal == "BUY":
            assert held.signal == "HOLD"
            assert held.rationale.endswith("Already holding this position; no new entry.")
            assert Decimal(str(held.confidence)) < Decimal(str(fresh.confidence))
            break
    else:
        pytest.skip("Fixture market produced no entry for any library strategy")


class HistoryConnector:
    """Wraps the replay connector with chain-read history, like HSKSwapConnector."""

    def __new__(cls, fail=False):
        from agent.tests.test_runtime import ReplayConnector

        class Connector(ReplayConnector):
            def price_history(self, block_number, block_timestamp, offsets, assets):
                if fail:
                    raise RuntimeError("archive state unavailable")
                self.requested = (offsets, assets)
                base = {
                    p.token0: p.mid_token1_per_token0
                    for p in self._fixture.pools
                    if p.token1 == "USDT"
                }
                return [
                    {
                        "observed_at": block_timestamp - offset,
                        "block_number": block_number - offset // 2,
                        "markets": {
                            a: {"price": str(base[a] * (Decimal(1) + Decimal(offset % 7) / 10000))}
                            for a in assets
                            if a in base
                        },
                        "source": "chain_history",
                    }
                    for offset in offsets
                ]

        return Connector()


def test_chain_history_removes_the_restart_warm_up(tmp_path):
    from aegis.runtime import PaperRuntime

    connector = HistoryConnector()
    runtime = PaperRuntime(tmp_path / "p.sqlite3", connector=connector, allow_test_connectors=True)
    try:
        runtime.set_params({"target_assets": ["WHSK"]}, runtime.version)
        state = runtime.tick()
        offsets, assets = connector.requested
        assert len([o for o in offsets if o <= 600]) == 20 and max(offsets) > 900
        assert "WHSK" in assets
        assert state["pool_activity"]["WHSK"]["status"] == "active"
        reasons = [s.get("reason", "") for s in state["signals"] if s.get("asset") == "WHSK"]
        assert reasons and not any(r.startswith("Warming up") for r in reasons)
        assert any(d["status"] == "history_backfilled" for d in state["decisions"])
        # Chain history is used in memory only; the ledger keeps just live observations.
        assert all(o.get("source") != "chain_history" for o in runtime.ledger.observations(300))
    finally:
        runtime.close()


def test_failed_history_read_falls_back_to_live_warm_up(tmp_path):
    from aegis.runtime import PaperRuntime

    runtime = PaperRuntime(
        tmp_path / "p.sqlite3", connector=HistoryConnector(fail=True), allow_test_connectors=True
    )
    try:
        runtime.set_params({"target_assets": ["WHSK"]}, runtime.version)
        state = runtime.tick()
        failed = [d for d in state["decisions"] if d["status"] == "history_backfill_failed"]
        assert failed and "archive state unavailable" in failed[0]["payload"]["reason"]
        assert state["pool_activity"]["WHSK"]["status"] == "warming"
        runtime.tick()  # No retry storm: a failed read waits before trying again.
        assert (
            len(
                [
                    d
                    for d in runtime.ledger.decisions(100)
                    if d["status"] == "history_backfill_failed"
                ]
            )
            == 1
        )
    finally:
        runtime.close()
