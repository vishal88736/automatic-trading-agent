"""What the assistant knows about the platform and how it guides a first-time trader.

Everything account-specific is computed from the runtime's recorded state, never assumed, so a
person with no trading background can ask what is happening and what to do next.
"""

from __future__ import annotations

import time
from decimal import Decimal

TOPICS = {
    "overview": (
        "Krono's AEGIS agent watches HSKSwap, a decentralized exchange on HashKey Chain. It reads "
        "live pool prices, lets rule-based strategies look for an entry, checks every idea against "
        "strict risk limits, and only then trades. PAPER mode uses 100 virtual USDT, so nothing "
        "real can be lost while you learn. TESTNET mode signs real transactions with test tokens."
    ),
    "workflow": (
        "Each market check runs five steps: 1) Market Monitor reads the latest verified block. "
        "2) On-chain analysis reads pool price, liquidity and fees. 3) Signals: strategies decide "
        "BUY, SELL or HOLD. 4) Risk gate: size, exposure, trade-rate, cooldown, pool activity and "
        "stop-loss rules can refuse the trade. 5) Execution: an approved trade is filled and "
        "recorded. HOLD or a refusal is normal; most checks end without a trade."
    ),
    "strategies": (
        "Momentum buys when trend indicators agree. Trend following rides a sustained direction. "
        "Breakout buys when price clears a recent range. Mean reversion buys a dip expecting a "
        "return to the average. Each is a fixed rule, not a prediction, and none guarantees profit."
    ),
    "risk": (
        "Stop-loss sells if a position falls by the set percent. Take-profit sells at the set "
        "gain. Position size limits how much one trade can use. NAV is your total portfolio value. "
        "Drawdown is the fall from its highest value. Daily loss and drawdown limits stop new "
        "trades automatically, and PANIC stops entries and sells open positions into USDT."
    ),
    "pools": (
        "A pool is the token pair people swap against. Quiet means its sampled price has not "
        "moved recently; swaps can still occur between observations. Quiet prices do not block "
        "entries. Locked pools or missing active liquidity do. Every trade still needs a fresh "
        "executable quote, a strategy or confirmed manual request, and all risk checks."
    ),
    "costs": (
        "Every trade pays a 0.3% pool fee plus price impact, which is larger on thin pools, plus a "
        "network fee. A round trip therefore starts at a loss, and price must move enough to cover "
        "it. Session analysis separates this cost from actual market movement."
    ),
    "sessions": (
        "A session is one run of the agent, from Start until Pause, PANIC or a restart. Manual "
        "trades you confirm form a session too. The Sessions page and this assistant keep every "
        "past session: result, trades, reasons and the settings used."
    ),
    "modes": (
        "PAPER: live mainnet prices with virtual funds. TESTNET: real signed Guard Vault swaps on "
        "chain 133 using test tokens with no monetary value. Real mainnet trading is not enabled."
    ),
}
TOPIC_NAMES = tuple(TOPICS)


def explain(topic: str = "overview") -> dict:
    if topic not in TOPICS:
        raise ValueError("Choose a topic: " + ", ".join(TOPIC_NAMES))
    return {"topic": topic, "summary": TOPICS[topic], "other_topics": list(TOPIC_NAMES)}


def _pools(state: dict) -> tuple[list[str], list[str]]:
    activity = state.get("pool_activity") or {}
    targets = state["params"]["target_assets"]
    active = [a for a in targets if a in activity and not activity[a].get("entry_blocked")]
    return active, [a for a in targets if a not in active]


def next_step(state: dict, sessions: list[dict]) -> dict:
    """The single most useful thing to do now, derived from the recorded state."""
    mode = state["mode"].upper()
    active, quiet = _pools(state)
    positions = state.get("positions") or []
    if state.get("emergency"):
        stage, summary, say = (
            "emergency",
            "The emergency stop is on, so no new trades can start. Open positions are being sold "
            "into USDT where possible. Review what happened, then clear it with the button on the "
            "AEGIS page; only a person can clear it.",
            ["Analyze my last session", "Show my positions"],
        )
    elif not state.get("valuation_fresh"):
        stage, summary, say = (
            "connecting",
            "Live market data is not available yet. It normally arrives within a few seconds. "
            + (f"Last problem: {state['last_error']}" if state.get("last_error") else ""),
            ["How does this work?"],
        )
    elif positions:
        held = ", ".join(
            f"{p['asset']} ({Decimal(p['unrealized_pnl_pct']):+.2f}%)" for p in positions
        )
        stage, summary, say = (
            "holding",
            f"You hold {held}. Stop-loss and take-profit rules keep watching it. You can wait, or "
            "sell it yourself; a sale always asks for your confirmation first.",
            [f"Sell {positions[0]['asset']}", "Show my positions and P&L", "What is a stop-loss?"],
        )
    elif state.get("paused"):
        if sessions:
            lead = (
                f"The agent is stopped and you have {len(sessions)} past session(s). "
                "Reviewing the last one shows what to adjust. "
            )
        else:
            lead = (
                f"Welcome. You are in {mode} mode and the agent is stopped, so nothing is trading. "
                + (
                    "Your funds are virtual, so this is safe to practise. "
                    if mode == "PAPER"
                    else ""
                )
            )
        market = (
            f"{', '.join(active)} has verified pool state; fresh quotes decide executable trades. "
            if active
            else "Target pool usability has not been verified yet. Refresh the market data. "
        )
        stage, summary, say = (
            "ready",
            lead + market + "When you are ready, start the agent or try one small trade yourself.",
            [
                "Start the agent",
                f"Buy 1 USDT of {(active or state['params']['target_assets'])[0]}",
                "Analyze my past sessions" if sessions else "How does this work?",
            ],
        )
    else:
        stage, summary, say = (
            "running",
            "The agent is running and checks the market on its own. No action is needed. A check "
            "that ends without a trade is normal. "
            + (f"Quiet pools it will not enter: {', '.join(quiet)}. " if quiet else ""),
            ["Why is it not trading?", "How is my current session going?", "Pause the agent"],
        )
    return {
        "mode": state["mode"],
        "stage": stage,
        "summary": summary + " You could say: " + " · ".join(f"“{s}”" for s in say),
        "try_saying": say,
    }


def why_not_trading(state: dict, *, include_pool_notes: bool = True) -> dict:
    """Every recorded reason there is no new trade, most decisive first."""
    params = state["params"]
    blockers = []
    if state.get("emergency"):
        blockers.append("The emergency stop is on; only a person can review and clear it.")
    elif state.get("paused"):
        blockers.append("The agent is stopped. New entries start only after you start it.")
    if not params["active_strategies"]:
        blockers.append("No entry strategy is selected. Choose strategies before enabling entries.")
    if not state.get("valuation_fresh"):
        blockers.append(state.get("last_error") or "Live market data is not fresh yet.")
    activity = state.get("pool_activity") or {}
    for asset in params["target_assets"]:
        row = activity.get(asset)
        if row and row.get("entry_blocked"):
            blockers.append(row["reason"])
    caps = state["caps"]
    last_fill = max((fill.get("created_at", 0) for fill in state.get("fills", [])), default=0)
    cooldown = caps.get("cooldown_seconds", 0) - (int(time.time()) - last_fill)
    if cooldown > 0:
        blockers.append(f"Entry cooldown: {cooldown} seconds remain after the last fill.")
    if state.get("trades_this_hour", 0) >= params["max_trades_per_hour"]:
        blockers.append(f"This hour's limit of {params['max_trades_per_hour']} trades is used.")
    if state.get("trades_today", 0) >= caps["max_trades_per_day"]:
        blockers.append(f"Today's limit of {caps['max_trades_per_day']} trades is used.")
    if len(state.get("positions") or []) >= caps["max_positions"]:
        blockers.append(f"The limit of {caps['max_positions']} open positions is reached.")
    signals = [
        {
            "strategy": s.get("strategy_name") or s.get("strategy_id"),
            "asset": s.get("asset"),
            "status": s.get("execution_status"),
            "reason": s.get("reason"),
        }
        for s in state.get("library_signals") or []
        if s.get("strategy_id") in params["active_strategies"]
    ]
    if "mean_reversion" in params["active_strategies"]:
        signals.extend(
            {
                "strategy": "Pool mean reversion",
                "asset": s.get("asset"),
                "status": "BUY_SIGNAL" if s.get("action") == "buy" else "HOLD",
                "reason": s.get("reason"),
            }
            for s in state.get("signals", [])
            if s.get("type") == "mean_reversion"
        )
    waiting = sum(s["status"] == "HOLD" for s in signals)
    refused = [s for s in signals if s["status"] == "BLOCKED"]
    buys = [s for s in signals if s["status"] == "ENTRY_EXECUTED"]
    recorded_ids = {
        f["id"]
        for step in state.get("pipeline", [])
        for f in step.get("evidence", {}).get("fills", [])
        if f.get("id")
    }
    for fill in state.get("fills", []):
        tokens = fill.get("quote", {}).get("route", {}).get("tokens", [])
        if (
            fill.get("id") in recorded_ids
            and tokens
            and tokens[0]["asset_id"] == "USDT"
            and tokens[-1]["asset_id"] != "USDT"
        ):
            asset = tokens[-1]["asset_id"]
            if not any(s["asset"] == asset for s in buys):
                buys.append({"asset": asset})
    notes = [
        row["reason"]
        for asset, row in activity.items()
        if asset in params["target_assets"] and not row.get("entry_blocked") and row.get("reason")
    ]
    if buys:
        summary = "The agent just traded: " + ", ".join(f"{b['asset']}" for b in buys) + "."
    elif blockers:
        summary = "No new trades because: " + " ".join(blockers)
    elif signals:
        summary = (
            f"Waiting for a valid entry: {waiting} of {len(signals)} strategy checks say HOLD, "
            f"and {len(refused)} are blocked by their recorded entry checks. "
            + " ".join(dict.fromkeys(s["reason"] for s in refused if s.get("reason")))
        )
        if waiting:
            reasons = list(
                dict.fromkeys(
                    s["reason"] for s in signals if s["status"] == "HOLD" and s.get("reason")
                )
            )[:3]
            summary += " Waiting conditions: " + " ".join(reasons)
    else:
        summary = "No strategy check is recorded yet; the next market check will add them."
    if notes and include_pool_notes:
        summary += " " + " ".join(notes)
    return {
        "mode": state["mode"],
        "blockers": blockers,
        "strategy_checks": signals[:20],
        "entry_recorded": bool(buys),
        "pool_notes": notes,
        "summary": summary,
    }


def entry_readiness(state: dict) -> dict:
    """Explain entry eligibility from recorded state without running a strategy or a trade."""
    explanation = why_not_trading(state, include_pool_notes=False)
    if state.get("emergency"):
        status, label = "blocked", "Emergency stop blocks entries"
    elif state.get("paused"):
        status, label = "paused", "Entries paused"
    elif not state.get("valuation_fresh"):
        status, label = "waiting_for_data", "Waiting for verified market data"
    elif explanation["blockers"]:
        status, label = "blocked", "Entry checks blocked"
    elif not state.get("last_tick_at") or not state.get("tick_count"):
        status, label = "checking", "Waiting for the next strategy check"
    elif explanation["entry_recorded"]:
        status, label = "entry_recorded", "Entry recorded in the latest strategy check"
    else:
        status, label = "waiting_for_signal", "Monitoring · waiting for an eligible entry"
    summary = explanation["summary"]
    if status in {"paused", "blocked", "waiting_for_data"} and explanation["blockers"]:
        summary = "New entries are waiting: " + " ".join(explanation["blockers"])
    if status in {"checking", "waiting_for_signal"}:
        summary += " Starting the agent enables monitoring; each trade still needs a valid signal, an executable quote and passing risk checks."
    return {"status": status, "label": label, "summary": summary}
