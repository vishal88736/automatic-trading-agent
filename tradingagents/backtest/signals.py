"""Signal sources for backtesting.

The primary source replays decisions the multi-agent pipeline already made
and persisted under ``eval_results/`` (see tradingagents/run_logger.py), so
evaluating past agent behavior costs zero LLM calls. Signals are normalized
to a common BUY/SELL/HOLD vocabulary; trading-mode outputs map onto it
(LONG->BUY, SHORT->SELL, NEUTRAL->HOLD).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Dict, Optional

ACTION_ALIASES = {
    "BUY": "BUY",
    "LONG": "BUY",
    "SELL": "SELL",
    "SHORT": "SELL",
    "HOLD": "HOLD",
    "NEUTRAL": "HOLD",
}

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def normalize_action(raw) -> Optional[str]:
    """Map any recognized signal spelling to BUY/SELL/HOLD, else None."""
    if raw is None:
        return None
    return ACTION_ALIASES.get(str(raw).strip().upper())


def _sanitize_symbol_for_path(symbol: str) -> str:
    # Must mirror run_logger._sanitize_for_path so we find its output dirs
    # (importing it would trigger the module's stale-log recovery side effect).
    sanitized = re.sub(r"[^\w\-.]+", "_", symbol.strip())
    return sanitized or "unknown"


def load_recorded_signals(
    symbol: str,
    eval_results_dir: str = "eval_results",
) -> Dict[str, str]:
    """Read persisted run logs and return {trade_date: normalized_action}.

    Only completed runs with a recognizable final signal count. When several
    runs exist for the same trade date, the most recently started one wins —
    it reflects the newest configuration of the pipeline.
    """
    runs_dir = (
        Path(eval_results_dir)
        / _sanitize_symbol_for_path(symbol)
        / "TradingAgentsStrategy_logs"
        / "runs"
    )
    if not runs_dir.is_dir():
        return {}

    best_per_date: Dict[str, tuple] = {}  # date -> (started_at, action)
    for path in sorted(runs_dir.glob("*.json")):
        try:
            with path.open("r", encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue

        if payload.get("status") != "completed":
            continue
        trade_date = str(payload.get("trade_date") or "").strip()
        if not _DATE_RE.match(trade_date):
            continue
        action = normalize_action((payload.get("summary") or {}).get("final_signal"))
        if action is None:
            continue

        started_at = str(payload.get("started_at") or "")
        current = best_per_date.get(trade_date)
        if current is None or started_at > current[0]:
            best_per_date[trade_date] = (started_at, action)

    return {date: action for date, (_, action) in sorted(best_per_date.items())}
