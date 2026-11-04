from __future__ import annotations

import pytest

from agent.tests.test_runtime import runtime as runtime
from backend.tests.test_aegis_api import H  # noqa: F401
from backend.tests.test_aegis_api import client as client


async def ask(client, message, *, endpoint="/api/aegis/chat"):
    response = await client.post(endpoint, headers=H, json={"message": message})
    assert response.status_code == 200, response.text
    return response.json()


async def test_chat_controls_use_actual_website_services_without_placing_orders(client):
    await client.post("/api/aegis/check", headers=H)
    before = (await client.get("/api/aegis/state", headers=H)).json()
    refresh = await ask(client, "Refresh live pool data now")
    assert refresh["tool"] == "refresh_market_data" and refresh["data"]["block_number"]
    assert (await client.get("/api/aegis/state", headers=H)).json()["tick_count"] == before[
        "tick_count"
    ]
    catalog = await ask(client, "List library strategies")
    assert len(catalog["data"]["items"]) == 5
    disabled = await ask(client, "Disable momentum strategy")
    assert disabled["tool"] == "set_library_strategy_enabled" and not disabled["data"]["enabled"]
    assert (await client.get("/api/aegis/state", headers=H)).json()["library_revision"] == 1
    original = (await client.get("/api/strategies", headers=H)).json()
    assert not next(s for s in original["items"] if s["id"] == "momentum_v1")["config"]["enabled"]
    await ask(client, "Enable momentum strategy")
    result = await ask(client, "Run a backtest for breakout on BTC")
    assert result["tool"] == "run_backtest" and "out_of_sample" in result["data"]
    routes = await ask(client, "Inspect routes for WHSK")
    assert routes["data"]["routes"]
    state = (await client.get("/api/aegis/state", headers=H)).json()
    assert state["fills"] == before["fills"] and state["paused"]


async def test_chat_alerts_are_shared_with_the_desk_and_delete_only_the_selected_alert(client):
    first = await ask(client, "Create a BTC alert above 100000")
    second = await ask(client, "Create an ETH alert below 1000")
    first_id = first["data"]["alert"]["id"]
    second_id = second["data"]["alert"]["id"]
    view = (await client.get("/api/alerts", headers=H)).json()
    assert {a["id"] for a in view["items"]} == {first_id, second_id}
    await ask(client, "Delete alert " + first_id)
    assert [a["id"] for a in (await client.get("/api/alerts", headers=H)).json()["items"]] == [
        second_id
    ]
    response = await client.post(
        "/api/aegis/chat", headers=H, json={"message": "Create a BTC alert above 0"}
    )
    assert response.status_code == 409


async def test_navigation_export_wallet_and_emergency_clear_are_typed_review_requests(client):
    await client.post("/api/aegis/check", headers=H)
    opened = await ask(client, "Open research strategies")
    assert opened["data"]["ui_action"] == {
        "type": "navigate",
        "workspace": "research",
        "page": "strategies",
    }
    exported = await ask(client, "Export trade history")
    data = exported["data"]["ui_action"]
    assert data["filename"] == "aegis-trade-history.json" and data["data"]["items"] == []
    wallet = await ask(client, "Deposit 2 USDT on mainnet")
    assert wallet["data"]["ui_action"] == {
        "type": "wallet_review",
        "action": "deposit",
        "network": "mainnet",
        "amount": "2",
    }
    assert (await client.get("/api/aegis/state", headers=H)).json()["mode"] == "paper"
    await ask(client, "Panic")
    preview = await ask(client, "Clear emergency stop")
    assert preview["data"]["kind"] == "emergency_clear" and preview["data"]["requires_confirmation"]
    assert (await client.get("/api/aegis/state", headers=H)).json()["emergency"]
    cleared = await client.post(
        "/api/aegis/control",
        headers=H,
        json={"action": "clear_emergency", "acknowledgement": "REVIEW_AND_CLEAR_PAPER_STOP"},
    )
    assert cleared.status_code == 200 and cleared.json()["paused"]
    assert not cleared.json()["emergency"] and not cleared.json()["fills"]


async def test_research_chat_can_open_website_controls_and_share_alerts(client):
    created = await ask(client, "Create a BTC alert above 100000", endpoint="/api/chat")
    assert created["tool"] == "create_alert"
    alerts = (await client.get("/api/alerts", headers=H)).json()["items"]
    assert alerts[0]["id"] == created["data"]["alert"]["id"]
    opened = await ask(client, "Open aegis wallet", endpoint="/api/chat")
    assert opened["data"]["ui_action"]["page"] == "wallet"
    exported = await ask(client, "Export trade history", endpoint="/api/chat")
    assert exported["data"]["workspace"] == "research"
    assert exported["data"]["ui_action"]["filename"] == "research-trade-history.json"


async def test_quiet_pool_questions_explain_evidence_without_claiming_zero_swaps(client):
    await client.post("/api/aegis/check", headers=H)
    answer = await ask(client, "Why are the pools inactive?")
    assert answer["tool"] == "why_not_trading"
    assert answer["data"]["pool_notes"]
    assert not any("price history" in reason for reason in answer["data"]["blockers"])


def test_strategy_refusals_are_not_described_as_nothing_blocking(runtime):
    from aegis.nl.guide import why_not_trading

    state = runtime.tick()
    state["paused"] = False
    state["library_signals"] = [
        {
            "strategy_id": "momentum_v1",
            "asset": "WBTC",
            "execution_status": "BLOCKED",
            "reason": "Reference basis exceeds cap",
        }
    ]
    answer = why_not_trading(state)
    assert "Reference basis exceeds cap" in answer["summary"]
    assert "Nothing is blocking" not in answer["summary"]


def test_tools_cannot_approve_reviews_inject_urls_or_send_raw_transactions():
    from pydantic import ValidationError

    from aegis.nl.agent import tool_schemas
    from aegis.nl.tools import ToolCall
    from aegis.nl.website import Navigation, Wallet

    names = {tool["name"] for tool in tool_schemas()}
    assert not names & {"clear_emergency", "trade_confirm", "eth_sendTransaction", "execute_shell"}
    with pytest.raises(ValidationError):
        Navigation(workspace="aegis", page="https://example.com")
    with pytest.raises(ValidationError):
        Wallet(action="deposit", network="mainnet", amount=1, transaction={"to": "anywhere"})
    with pytest.raises(ValidationError):
        ToolCall(name="trade_confirm", arguments={"confirmation": "guessed"})
