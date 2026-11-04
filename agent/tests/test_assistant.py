"""A person with no trading knowledge can learn, review history and trade through the assistant."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from aegis.nl.agent import ControlAgent, tool_schemas
from aegis.nl.providers import ProviderRateLimited
from aegis.nl.tools import ToolCall, chat, execute_tool, interpret
from aegis.risk.engine import RiskRejected
from agent.tests.test_runtime import mark_pools_active, seed_entry
from agent.tests.test_runtime import runtime as runtime  # noqa: F401 - pytest fixture


def ready(runtime):
    runtime.tick(evaluate_entries=False)
    mark_pools_active(runtime)
    runtime.tick(evaluate_entries=False)
    return runtime


def wait_out_cooldown(runtime):
    """Age recorded fills past the 30-second entry cooldown."""
    for rowid, raw in list(runtime.ledger.db.execute("SELECT rowid,result_json FROM fills")):
        fill = json.loads(raw)
        fill["created_at"] -= 120
        runtime.ledger.db.execute(
            "UPDATE fills SET result_json=? WHERE rowid=?", (json.dumps(fill), rowid)
        )


@pytest.mark.parametrize(
    "text,tool",
    [
        ("What should I do next?", "get_next_step"),
        ("I'm new here, help me", "get_next_step"),
        ("how do i start trading", "get_next_step"),
        ("ab kya karu", "get_next_step"),
        ("How does this work?", "explain_platform"),
        ("What is a stop-loss?", "explain_platform"),
        ("what is a pool", "explain_platform"),
        ("Why is it not trading?", "why_not_trading"),
        ("why are there no trades", "why_not_trading"),
        ("Analyze my past sessions", "analyze_sessions"),
        ("compare all sessions", "analyze_sessions"),
        ("How is my current session going?", "get_session"),
        ("show session 2", "get_session"),
        ("Buy 5 USDT of WHSK", "request_trade"),
        ("please sell half of my bitcoin", "request_trade"),
        ("Start the agent", "resume"),
        # Existing commands keep their meaning.
        ("Set position size to 8 USDT and frequency to 45s", "update_strategy_config"),
        ("trade only ETH", "set_params"),
        ("buy only ETH", "set_params"),
        ("show only ETH positions", "get_positions"),
        ("How am I doing today?", "get_pnl"),
        ("explain latest decision", "explain_latest_decision"),
        ("sell everything", "close_all_positions"),
    ],
)
def test_plain_language_reaches_the_right_tool(text, tool):
    assert interpret(text, target_assets=("WHSK", "WETH")).name == tool


def test_trade_words_become_amounts():
    assert interpret("Buy 5 USDT of WHSK").arguments == {
        "side": "buy",
        "asset": "WHSK",
        "amount_usdt": "5",
    }
    assert interpret("sell half of weth").arguments["sell_fraction"] == "0.5"
    assert interpret("sell 25% of WBTC").arguments["sell_fraction"] == "0.25"
    with pytest.raises(ValueError, match="name what to buy"):
        interpret("buy something good")


def test_first_time_guidance_follows_the_actual_state(runtime):
    start = chat(runtime, "What should I do next?")
    assert start["data"]["stage"] == "connecting"
    ready(runtime)
    welcome = chat(runtime, "What should I do next?")
    assert welcome["data"]["stage"] == "ready"
    assert "Welcome" in welcome["response"] and "virtual" in welcome["response"]
    assert "Start the agent" in welcome["data"]["try_saying"]
    assert chat(runtime, "How does this work?")["data"]["topic"] == "overview"
    why = chat(runtime, "Why is it not trading?")
    assert "stopped" in why["response"]
    runtime.control("resume", acknowledgement="AUTHORIZE_PAPER_AUTOMATION")
    assert chat(runtime, "What should I do next?")["data"]["stage"] == "running"
    runtime.control("panic")
    assert chat(runtime, "What should I do next?")["data"]["stage"] == "emergency"


def test_a_novice_can_buy_and_sell_only_through_human_confirmation(runtime):
    ready(runtime)
    preview = chat(runtime, "Buy 3 USDT of WHSK")
    data = preview["data"]
    assert data["kind"] == "trade_preview" and data["requires_confirmation"]
    assert "Buy about" in preview["response"]
    assert runtime.ledger.fills() == [], "A preview executes nothing"
    assert runtime.view()["paused"] is True

    with pytest.raises(ValueError, match="invalid or expired"):
        runtime.control("trade_confirm", confirmation="guessed")
    runtime.control("trade_confirm", confirmation=data["confirmation"])
    [bought] = runtime.ledger.fills()
    assert bought["execution_context"]["manual"] is True
    assert runtime.view()["paused"] is True, "A manual trade does not start the agent"
    assert runtime.running is True, "Stops keep being checked for the open position"
    with pytest.raises(ValueError, match="invalid or expired"):
        runtime.control("trade_confirm", confirmation=data["confirmation"])  # One use only.

    guidance = chat(runtime, "What should I do next?")["data"]
    assert guidance["stage"] == "holding" and "Sell WHSK" in guidance["try_saying"]
    wait_out_cooldown(runtime)
    sale = chat(runtime, "Sell WHSK")["data"]
    assert sale["side"] == "sell" and sale["estimated_result_usdt"]
    runtime.control("trade_confirm", confirmation=sale["confirmation"])
    assert len(runtime.ledger.fills()) == 2 and not runtime.view()["positions"]

    [session] = runtime.sessions()["items"]
    assert session["end_reason"] == "manual_closed" and session["trades"] == 2
    detail = runtime.session_detail(session["id"])
    assert detail["started_at"] <= bought["created_at"]
    assert detail["positions"][0]["strategy_id"] == "manual"
    assert detail["positions"][0]["exit_reason"] == "manual sell"
    kinds = [item["kind"] for item in detail["timeline"]]
    assert kinds == ["start", "buy", "sell"]
    assert "You confirmed this buy" in detail["timeline"][1]["detail"]


def test_manual_trades_keep_every_other_limit(runtime):
    ready(runtime)
    with pytest.raises(RiskRejected, match=r"most you can buy right now is 5\.0000 USDT"):
        chat(runtime, "Buy 50 USDT of WHSK")
    with pytest.raises(ValueError, match="do not hold WETH"):
        chat(runtime, "Sell WETH")
    with pytest.raises(ValueError, match="positive USDT"):
        execute_tool(
            runtime,
            ToolCall(
                name="request_trade", arguments={"side": "buy", "asset": "WHSK", "amount_usdt": -1}
            ),
        )
    runtime.set_params({"target_assets": ["WETH"]}, runtime.version)
    with pytest.raises(RiskRejected, match="Target asset is disabled"):
        chat(runtime, "Buy 1 USDT of WHSK")
    runtime.set_params({"target_assets": ["WHSK"]}, runtime.version)
    preview = chat(runtime, "Buy 1 USDT of WHSK")["data"]
    runtime.control("panic")
    with pytest.raises(RiskRejected, match="emergency"):
        chat(runtime, "Buy 1 USDT of WHSK")
    with pytest.raises(RiskRejected):
        runtime.control("trade_confirm", confirmation=preview["confirmation"])
    assert runtime.ledger.fills() == []
    assert not runtime.sessions()["items"], "A failed attempt is not a session"


def test_quiet_pool_warns_the_person_instead_of_hiding(runtime):
    runtime.tick(evaluate_entries=False)
    data = chat(runtime, "Buy 1 USDT of WHSK")["data"]
    assert any("price history" in w for w in data["warnings"])
    runtime.control("trade_confirm", confirmation=data["confirmation"])
    assert len(runtime.ledger.fills()) == 1
    # The agent's own automatic entries stay blocked by the same condition.
    assert runtime.manual_intent is False


def test_changed_holdings_or_expiry_invalidate_a_preview(runtime):
    ready(runtime)
    data = chat(runtime, "Buy 1 USDT of WHSK")["data"]
    pending = runtime.ledger.metadata("trade_confirmation")
    runtime.ledger.set_metadata("trade_confirmation", {**pending, "expires_at": 1})
    with pytest.raises(ValueError, match="expired"):
        runtime.control("trade_confirm", confirmation=data["confirmation"])
    data = chat(runtime, "Buy 1 USDT of WHSK")["data"]
    pending = runtime.ledger.metadata("trade_confirmation")
    runtime.ledger.set_metadata("trade_confirmation", {**pending, "balances_hash": "other"})
    with pytest.raises(ValueError, match="holdings changed"):
        runtime.control("trade_confirm", confirmation=data["confirmation"])


def test_price_worse_than_preview_is_refused(runtime):
    ready(runtime)
    data = chat(runtime, "Buy 1 USDT of WHSK")["data"]
    pending = runtime.ledger.metadata("trade_confirmation")
    impossible = str(int(pending["min_out_raw"]) * 100)
    runtime.ledger.set_metadata("trade_confirmation", {**pending, "min_out_raw": impossible})
    with pytest.raises(RiskRejected):
        runtime.control("trade_confirm", confirmation=data["confirmation"])
    assert runtime.ledger.fills() == []


def test_session_knowledge_covers_current_previous_and_all(runtime):
    assert chat(runtime, "Analyze my past sessions")["data"]["closed_trades"] == 0
    seed_entry(runtime)
    runtime.control("pause")
    runtime.control("panic")
    runtime.tick()
    current = chat(runtime, "How is my current session going?")
    assert current["tool"] == "get_session" and current["data"]["number"] == 1
    assert "series" not in current["data"], "The chart series would waste model tokens"
    assert "panic unwind" in current["response"]
    assert chat(runtime, "show session 1")["data"]["number"] == 1
    with pytest.raises(ValueError, match="Session 9 does not exist"):
        chat(runtime, "show session 9")
    analysis = chat(runtime, "Analyze my past sessions")
    data = analysis["data"]
    assert data["sessions"] == 1 and data["closed_trades"] == 1
    assert data["by_strategy"][0]["strategy_id"] == "mean_reversion"
    assert data["by_exit_reason"][0]["exit_reason"] == "panic unwind"
    assert data["average_execution_cost_pct"] is not None
    assert any("PANIC" in o for o in data["observations"])
    json.dumps(data)  # Every value must reach the model as plain JSON.
    assert len(json.dumps(data)) < 4000, "Stay inside the provider's token budget"


class Block:
    def __init__(self, **value):
        self.value, self.type = value, value["type"]

    def model_dump(self, **kwargs):
        return self.value


def provider(*replies):
    requests = []

    def create(**request):
        requests.append(json.loads(json.dumps(request, default=str)))
        return SimpleNamespace(content=[Block(**b) for b in replies[len(requests) - 1]])

    client = SimpleNamespace(create=create, requests=requests)
    client.messages = client
    return client


def tool_use(name, **arguments):
    return {"type": "tool_use", "id": "t1", "name": name, "input": arguments}


def test_recognized_questions_read_data_first_and_the_model_only_explains(runtime):
    seed_entry(runtime)
    client = provider([{"type": "text", "text": "Aapka session chal raha hai."}])
    agent = ControlAgent(providers=[("test", "m", client)])
    result = agent.respond(runtime, "Mera pichhla session kaisa gaya?")
    assert result["tool"] == "get_session" and result["data"]["number"] == 1
    assert result["response"] == "PAPER: Aapka session chal raha hai."
    [request] = client.requests
    assert request["tools"] == [], "One small request, with no tool schemas to pay for"
    assert "recorded_result" in request["messages"][-1]["content"]
    assert "explained recorded data" in result["engine"]


def test_recognized_questions_still_answer_when_every_model_is_busy(runtime):
    seed_entry(runtime)

    def limited(**request):
        raise ProviderRateLimited("Groq", 30)

    client = SimpleNamespace(create=limited)
    client.messages = client
    agent = ControlAgent(providers=[("groq", "m", client)])
    result = agent.respond(runtime, "Analyze my past sessions")
    assert result["tool"] == "analyze_sessions" and "Across 1 session(s)" in result["response"]
    assert "unavailable" in result["engine"]
    assert agent.status()["last_failure"].startswith("Groq rate limit")


def test_last_session_skips_empty_runs_but_current_does_not(runtime):
    seed_entry(runtime)
    runtime.control("pause")
    runtime.running = True
    runtime.control("resume", acknowledgement="AUTHORIZE_PAPER_AUTOMATION")
    last = chat(runtime, "how did my last session go")["data"]
    assert last["number"] == 1 and last["trades"] >= 1
    assert chat(runtime, "how is my current session going")["data"]["number"] == 2


def test_rate_limit_tries_the_next_model_before_waiting():
    import httpx

    from aegis.nl.providers import OpenAICompatible

    models, waits = [], []

    def handler(request):
        body = json.loads(request.content)
        assert "tools" not in body and "parallel_tool_calls" not in body
        models.append(body["model"])
        if body["model"] == "main":
            return httpx.Response(429, headers={"retry-after": "5"}, json={"error": {}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    client = OpenAICompatible(
        "k",
        "https://api.groq.com/openai/v1",
        transport=httpx.MockTransport(handler),
        sleep=waits.append,
        fallback_models=["small"],
    )
    client.create(model="main", system="s", tools=[], messages=[], max_tokens=5)
    assert models == ["main", "small"] and waits == [] and client.last_model == "small"
    client.close()


def test_model_can_prepare_a_trade_but_never_see_or_use_its_confirmation(runtime):
    ready(runtime)
    client = provider([tool_use("request_trade", side="buy", asset="WHSK", amount_usdt=2)])
    agent = ControlAgent(providers=[("test", "m", client)])
    result = agent.respond(runtime, "put two dollars into hsk")
    assert result["data"]["requires_confirmation"] and runtime.ledger.fills() == []
    assert "nothing happens until you confirm" in result["response"]
    assert len(client.requests) == 1, "The token never goes back to the model"
    names = {tool["name"] for tool in tool_schemas()}
    assert not {"trade_confirm", "confirm_trade"} & names
    with pytest.raises(ValueError):
        ToolCall(name="trade_confirm", arguments={})


def test_model_reads_session_history_through_tools(runtime):
    seed_entry(runtime)
    client = provider(
        [tool_use("analyze_sessions")],
        [{"type": "text", "text": "You have one session so far."}],
    )
    agent = ControlAgent(providers=[("test", "m", client)])
    result = agent.respond(runtime, "how did my earlier runs do")
    assert result["tool"] == "analyze_sessions"
    assert result["response"] == "PAPER: You have one session so far."
    context = json.loads(client.requests[0]["messages"][-1]["content"])["observed_state"]
    assert context["sessions_recorded"] == 1 and context["latest_session"]["number"] == 1


def test_follow_ups_receive_bounded_scrubbed_history(runtime):
    runtime.tick()
    client = provider([{"type": "text", "text": "A stop-loss limits your loss."}])
    agent = ControlAgent(providers=[("test", "m", client)])
    secret = "gsk_" + "a" * 30
    history = [
        {"role": "assistant", "text": "dropped: a conversation starts with the user"},
        *[{"role": "user" if i % 2 == 0 else "assistant", "text": f"turn {i}"} for i in range(4)],
        {"role": "user", "text": "my key is " + secret + " " + "x" * 2000},
        {"role": "assistant", "text": "noted"},
    ]
    result = agent.respond(runtime, "and what does that mean?", history)
    sent = client.requests[0]["messages"]
    roles = [m["role"] for m in sent]
    assert roles[0] == "user" and roles[-1] == "user" and len(sent) <= 7
    assert all(a != b for a, b in zip(roles, roles[1:])), "Providers need alternating roles"
    assert secret not in json.dumps(sent) and all(len(m["content"]) <= 500 for m in sent[:-1])
    # A general answer is honest about reading no account data.
    assert result["tool"] is None and "no account data" in result["engine"]


def test_a_model_that_keeps_calling_tools_still_produces_an_answer(runtime):
    seed_entry(runtime)
    client = provider(*[[tool_use("analyze_sessions")]] * 3)
    agent = ControlAgent(providers=[("test", "m", client)])
    result = agent.respond(runtime, "overall, give me a full account of my runs")
    assert len(client.requests) == 3
    assert result["tool"] == "analyze_sessions" and "Across 1 session(s)" in result["response"]


def test_replies_are_plain_text_with_one_mode_label(runtime):
    seed_entry(runtime)
    client = provider([{"type": "text", "text": "PAPER: **Your result** is small."}])
    agent = ControlAgent(providers=[("test", "m", client)])
    result = agent.respond(runtime, "Analyze my past sessions")
    assert result["response"] == "PAPER: Your result is small."


@pytest.mark.parametrize(
    "text",
    [
        "aur isse behtar kaise ho sakta hai?",
        "how can I improve?",
        "what went wrong",
        "loss kyun hua",
    ],
)
def test_improvement_questions_read_the_recorded_analysis(text):
    assert interpret(text).name == "analyze_sessions"
