import asyncio
from datetime import timedelta

import pytest

from backend.data import Providers
from backend.engine import Engine
from backend.models import Authorize, RunRequest, SchedulerAction, now
from backend.storage import Store


@pytest.fixture
def engine(tmp_path, monkeypatch):
    # Tests never inherit a developer's live mode or provider permissions.
    monkeypatch.setenv("TERMINAL_MODE", "SIMULATION")
    monkeypatch.setenv("RESEARCH_ENABLED", "false")
    store = Store(str(tmp_path / "terminal.sqlite3"))
    value = Engine(store, Providers(store))
    yield value
    store.close()


async def preview(engine):
    run = await engine.run(RunRequest())
    assert run["decision"] == "BUY" and run["intent"]["state"] == "AWAITING_AUTHORIZATION"
    intent = run["intent"]
    return Authorize(
        intent_id=intent["id"],
        quote_id=intent["quote"]["id"],
        acknowledgement="AUTHORIZE_SIMULATION",
    )


async def test_full_graph_fill_reconciliation_and_duplicate_guard(engine):
    request = await preview(engine)
    result = await engine.authorize(request)
    assert result["state"] == "RECONCILED" and result["transaction_hash"] is None
    assert result["receipt_id"].startswith("sim:")
    portfolio = engine.portfolio.view(engine.markets)
    assert len(portfolio["positions"]) == 1 and 9999 < portfolio["equity"] < 10000
    assert portfolio["realized_pnl"] == 0 and portfolio["unrealized_pnl"] < 0
    assert engine.store.history("ledger")["total"] == 1
    with pytest.raises(ValueError, match="already processed"):
        await engine.authorize(request)
    latest = engine.store.history("runs", 1)["items"][0]
    assert all(
        s["status"] == "COMPLETED"
        for s in latest["stages"]
        if s["name"] in {"Executor", "Reconciliation"}
    )
    assert {a["kind"] for a in engine.store.history("audit", 200)["items"]} >= {
        "risk.approved",
        "execution.authorized",
        "portfolio.reconciled",
    }


async def test_concurrent_authorization_only_fills_once(engine):
    request = await preview(engine)
    results = await asyncio.gather(
        engine.authorize(request), engine.authorize(request), return_exceptions=True
    )
    assert sum(isinstance(result, dict) for result in results) == 1
    assert engine.store.history("ledger")["total"] == 1


async def test_emergency_stop_latches_and_blocks_pending_authorization(engine):
    request = await preview(engine)
    engine.control(SchedulerAction(action="emergency_stop"))
    with pytest.raises(ValueError, match="Emergency"):
        await engine.authorize(request)
    with pytest.raises(ValueError, match="latched"):
        engine.control(SchedulerAction(action="resume"))
    assert engine.store.history("ledger")["total"] == 0
    engine.control(SchedulerAction(action="clear_emergency", acknowledge=True))
    assert engine.state()["entries_paused"] and engine.state()["state"] == "PAUSED"


async def test_stale_quote_and_configuration_changes_fail_closed(engine):
    request = await preview(engine)
    intent = engine.store.get("intents", request.intent_id)
    intent["quote"]["expires_at"] = (now() - timedelta(seconds=1)).isoformat()
    engine.store.put(
        "intents", intent["id"], intent, state=intent["state"], proposal_id=intent["proposal_id"]
    )
    with pytest.raises(ValueError, match="expired"):
        await engine.authorize(request)
    current, version = engine.execution.risk()
    engine.store.update_config("risk", current.model_dump(mode="json"), version)
    with pytest.raises(ValueError, match="Configuration changed"):
        await engine.authorize(request)


async def test_restart_recovers_pending_without_resubmission(engine):
    request = await preview(engine)
    intent = engine.store.get("intents", request.intent_id)
    intent["state"] = "SUBMITTED"
    engine.store.put(
        "intents", intent["id"], intent, state=intent["state"], proposal_id=intent["proposal_id"]
    )
    engine.control(SchedulerAction(action="start"))
    engine.recover()
    assert engine.state()["state"] == "PAUSED"
    assert engine.store.get("intents", intent["id"])["state"] == "RECONCILIATION_REQUIRED"
    assert engine.execution.reconcile(intent["id"])["state"] == "RECONCILIATION_REQUIRED"
    assert engine.store.history("ledger")["total"] == 0


async def test_empty_data_blocks_executable_candidates(engine):
    original = engine.providers.market

    async def unavailable(symbol):
        market = await original(symbol)
        return market.model_copy(update={"candles": [], "status": "UNAVAILABLE", "price": None})

    engine.providers.market = unavailable
    run = await engine.run(RunRequest())
    assert run.get("decision") == "HOLD" and not run.get("intent_id")


def test_configuration_versions_prevent_lost_updates(engine):
    config, version = engine.store.config("strategy:momentum_v1")
    engine.store.update_config("strategy:momentum_v1", config, version)
    with pytest.raises(ValueError, match="reload"):
        engine.store.update_config("strategy:momentum_v1", config, version)
