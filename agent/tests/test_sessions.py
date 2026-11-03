"""Sessions are reconstructed from durable ledger rows: start → trades → stop → wind-down."""

from __future__ import annotations

from decimal import Decimal

from aegis.runtime import PaperRuntime
from aegis.sessions import boundaries
from agent.tests.test_runtime import ReplayConnector, seed_entry
from agent.tests.test_runtime import runtime as runtime  # noqa: F401 - pytest fixture


def test_session_records_settings_trades_decisions_and_pnl(runtime):
    seed_entry(runtime)  # resume + one mean-reversion entry
    runtime.control("pause")
    runtime.control("panic")
    runtime.tick()  # PANIC unwind sells the position after the stop

    sessions = runtime.sessions()["items"]
    assert len(sessions) == 1
    summary = sessions[0]
    assert summary["status"] == "ended" and summary["end_reason"] == "panic"
    assert summary["end_label"] == "PANIC emergency stop"
    assert summary["entries"] == 1 and summary["exits"] == 1
    assert summary["start_nav_usdt"] is not None and summary["net_pnl_usdt"] is not None

    detail = runtime.session_detail(summary["id"])
    assert detail["settings_source"] == "recorded at session start"
    assert detail["settings"]["target_assets"] == ["WHSK"]
    [position] = detail["positions"]
    assert position["asset"] == "WHSK" and position["status"] == "closed"
    assert position["exit_reason"] == "panic unwind"
    realized = sum(Decimal(t["realized_pnl_usdt"]) for t in detail["fills"])
    assert Decimal(summary["realized_pnl_usdt"]) == realized
    assert Decimal(position["realized_pnl_usdt"]) == realized

    kinds = [item["kind"] for item in detail["timeline"]]
    assert kinds[0] == "start" and "buy" in kinds and "sell" in kinds
    # Pause and PANIC a moment apart are one stop in the story, not two.
    assert kinds.count("stop") == 1
    stop = next(i for i in detail["timeline"] if i["kind"] == "stop")
    assert stop["title"] == "PANIC stop"
    buy = next(i for i in detail["timeline"] if i["kind"] == "buy")
    assert buy["strategy_id"] == "mean_reversion" and buy["price_usdt"]
    assert buy["detail"]  # why the agent bought
    sell = next(i for i in detail["timeline"] if i["kind"] == "sell")
    assert sell["detail"] == "Exit: panic unwind" and sell["realized_pnl_usdt"] is not None
    assert detail["series"] and detail["series"][-1]["nav_usdt"]
    assert detail["activity"]["market_checks"] >= 1


def test_restart_ends_the_session_and_a_new_resume_starts_another(tmp_path):
    path = tmp_path / "paper.sqlite3"
    first = PaperRuntime(path, connector=ReplayConnector(), allow_test_connectors=True)
    first.set_params({"target_assets": ["WHSK"]}, first.version)
    first.tick()
    first.control("resume", acknowledgement="AUTHORIZE_PAPER_AUTOMATION")
    first.close()
    second = PaperRuntime(path, connector=ReplayConnector(), allow_test_connectors=True)
    try:
        second.tick()
        second.control("resume", acknowledgement="AUTHORIZE_PAPER_AUTOMATION")
        items = second.sessions()["items"]
        assert [s["number"] for s in items] == [2, 1]  # newest first
        assert items[1]["end_reason"] == "restart" and items[0]["status"] == "running"
        assert items[1]["trades"] == 0
        windows = boundaries(second.ledger)
        assert windows[0]["end_rowid"] == windows[1]["start_rowid"]
    finally:
        second.close()


def test_unknown_session_is_refused(runtime):
    import pytest

    with pytest.raises(ValueError, match="Session not found"):
        runtime.session_detail("00000000-0000-0000-0000-000000000000")
