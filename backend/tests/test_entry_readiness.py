from __future__ import annotations

from aegis.nl.guide import entry_readiness
from agent.tests.test_runtime import runtime as runtime
from backend.tests.test_aegis_api import H
from backend.tests.test_aegis_api import client as client


def test_enabled_entries_explain_hold_conditions_without_creating_trades(runtime):
    state = runtime.tick()
    runtime.control("resume", acknowledgement="AUTHORIZE_PAPER_AUTOMATION")
    state = runtime.tick()
    readiness = entry_readiness(state)
    assert readiness["status"] == "waiting_for_signal"
    assert "valid signal" in readiness["summary"]
    assert any(signal["reason"] in readiness["summary"] for signal in state["signals"])
    assert not runtime.ledger.fills()


def test_empty_entry_selection_and_stale_data_explain_the_actual_gate(runtime):
    runtime.tick()
    runtime.control("resume", acknowledgement="AUTHORIZE_PAPER_AUTOMATION")
    runtime.set_params({"active_strategies": []}, runtime.version)
    state = runtime.view()
    assert entry_readiness(state)["status"] == "blocked"
    assert "No entry strategy" in entry_readiness(state)["summary"]
    state["valuation_fresh"] = False
    assert entry_readiness(state)["status"] == "waiting_for_data"


async def test_readiness_poll_only_reads_recorded_state(client):
    await client.post("/api/aegis/check", headers=H)
    before = (await client.get("/api/aegis/state", headers=H)).json()
    assert before["entry_readiness"]["status"] == "paused"
    await client.post(
        "/api/aegis/control",
        headers=H,
        json={"action": "resume", "acknowledgement": "AUTHORIZE_PAPER_AUTOMATION"},
    )
    after = (await client.get("/api/aegis/state", headers=H)).json()
    assert after["entry_readiness"]["status"] == "waiting_for_signal"
    assert after["tick_count"] == before["tick_count"]
    assert after["fills"] == before["fills"]
