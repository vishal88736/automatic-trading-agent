import pytest

from aegis.nl.tools import chat
from agent.tests.test_runtime import runtime as runtime


def test_named_preferences_cover_advanced_controls_and_keep_schema_caps(runtime):
    chat(runtime, "Set trailing stop pct to 2%")
    chat(runtime, "Set max holding seconds to 1200")
    chat(runtime, 'Set target assets to ["WHSK", "WBTC"]')
    assert runtime.params.trailing_stop_pct == 2
    assert runtime.params.max_holding_seconds == 1200
    assert runtime.params.target_assets == ("WHSK", "WBTC")
    version = runtime.version
    with pytest.raises(ValueError):
        chat(runtime, "Set position size pct to 99%")
    assert runtime.version == version and runtime.params.position_size_pct <= 10


def test_conversational_pause_and_swap_explanation_use_validated_tools(runtime):
    runtime.control("resume", acknowledgement="AUTHORIZE_PAPER_AUTOMATION")
    assert not runtime.halted.is_set()
    assert chat(runtime, "Pause the agent")["tool"] == "pause"
    assert runtime.halted.is_set()
    assert chat(runtime, "Why did you execute that last swap?")["tool"] == "explain_latest_decision"


def test_target_negation_does_not_reenable_the_excluded_asset(runtime):
    chat(runtime, "Stop trading WETH and only trade WHSK/USDT")
    assert runtime.params.target_assets == ("WHSK",)
    chat(runtime, "Only trade WHSK and WETH")
    chat(runtime, "Stop trading WETH")
    assert runtime.params.target_assets == ("WHSK",)
    with pytest.raises(ValueError, match="Removing every target"):
        chat(runtime, "Stop trading WHSK")
    assert runtime.params.target_assets == ("WHSK",)


@pytest.mark.parametrize(
    "command",
    [
        "Lower my trade size to 25 USDC per swap.",
        "Stop trading WETH and only trade WHSK/USDC.",
        "Switch to low risk: tighten my stop-loss to 2% and only take arbitrage spreads above 0.8%.",
    ],
)
def test_unsupported_mixed_requests_are_refused_atomically(runtime, command):
    before, version = runtime.params.model_dump(), runtime.version
    with pytest.raises(ValueError, match="No changes applied"):
        chat(runtime, command)
    assert runtime.params.model_dump() == before and runtime.version == version


def test_minutes_parse_but_never_override_the_frequency_ceiling(runtime):
    assert chat(runtime, "Only scan every 2 minutes")["tool"] == "update_strategy_config"
    assert runtime.params.tick_seconds == 120
    before = runtime.params.model_dump()
    with pytest.raises(ValueError, match="300"):
        chat(runtime, "Only scan and execute trades once every 10 minutes.")
    assert runtime.params.model_dump() == before


def test_low_risk_alias_and_unknown_command_feedback_are_explicit(runtime):
    chat(runtime, "Switch to low risk with stop-loss to 2%")
    assert runtime.params.risk_level == "conservative" and runtime.params.stop_loss_pct == 2
    reply = chat(runtime, "Hello, can we discuss markets?")
    assert "Command mode" in reply["response"] and "configured provider" in reply["response"]
