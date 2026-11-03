"""Trading sessions reconstructed from the durable AEGIS ledger.

A session starts when the operator resumes the agent and ends at the next pause, PANIC,
circuit breaker or process restart. Exits that settle after the stop (a PANIC unwind, a stop
loss while paused) still belong to the session that opened those positions, so every session
owns the ledger rows from its start up to the next session's start.

Everything here is read-only and derived from recorded rows: no prices are re-fetched and no
values are estimated. A value that was not recorded is reported as missing.
"""

from __future__ import annotations

import json
from decimal import Decimal

from aegis.store.db import PaperLedger

STOP_ACTIONS = {"pause": "Paused", "panic": "PANIC stop", "close_all_confirm": "Closed all"}
END_REASONS = {
    "pause": "Paused by operator",
    "panic": "PANIC emergency stop",
    "close_all_confirm": "Closed all positions",
    "restart": "Process restarted",
    "circuit_breaker": "Circuit breaker tripped",
}
# A PANIC right after a pause describes the same stop; it upgrades that session's end reason.
PANIC_MERGE_SECONDS = 60
MAX_SERIES_POINTS = 240


def _d(value) -> Decimal | None:
    try:
        return None if value is None else Decimal(str(value))
    except ArithmeticError:
        return None


def _s(value: Decimal | None) -> str | None:
    return None if value is None else format(value.normalize(), "f")


def _rows(ledger: PaperLedger, sql: str, args=()) -> list:
    return list(ledger.db.execute(sql, args))


def boundaries(ledger: PaperLedger) -> list[dict]:
    """Ordered start/stop windows. `end_rowid` is the next session's start (exclusive)."""
    events = _rows(
        ledger,
        "SELECT rowid, id, created_at, status, payload_json FROM decisions "
        "WHERE status IN ('control_changed','recovered_paused','circuit_breaker') ORDER BY rowid",
    )
    sessions: list[dict] = []
    current = None
    for rowid, event_id, at, status, raw in events:
        payload = json.loads(raw)
        action = payload.get("action") if status == "control_changed" else status
        if action == "resume":
            if current is None:
                current = {
                    "id": event_id,
                    "start_rowid": rowid,
                    "started_at": at,
                    "start_payload": payload,
                    "ended_at": None,
                    "end_reason": None,
                }
                sessions.append(current)
            continue
        if action == "recovered_paused":
            action = "restart"
        if action not in END_REASONS:
            continue
        if current is not None:
            current.update(ended_at=at, end_reason=action, end_payload=payload)
            current = None
        elif (
            action == "panic"
            and sessions
            and sessions[-1]["end_reason"] == "pause"
            and at - sessions[-1]["ended_at"] <= PANIC_MERGE_SECONDS
        ):
            sessions[-1]["end_reason"] = "panic"
    for index, session in enumerate(sessions):
        session["number"] = index + 1
        following = sessions[index + 1] if index + 1 < len(sessions) else None
        session["end_rowid"] = following["start_rowid"] if following else None
        session["window_end_at"] = following["started_at"] if following else None
    return sessions


def _window(ledger: PaperLedger, session: dict, statuses: tuple[str, ...] | None = None) -> list:
    clause = "rowid >= ?" + (" AND rowid < ?" if session["end_rowid"] else "")
    args = [session["start_rowid"], *([session["end_rowid"]] if session["end_rowid"] else [])]
    if statuses:
        clause += f" AND status IN ({','.join('?' * len(statuses))})"
        args.extend(statuses)
    return [
        {"id": r[0], "created_at": r[1], "status": r[2], "payload": json.loads(r[3])}
        for r in _rows(
            ledger,
            f"SELECT id, created_at, status, payload_json FROM decisions WHERE {clause} ORDER BY rowid",
            args,
        )
    ]


def _fills(ledger: PaperLedger, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    rows = _rows(
        ledger,
        f"SELECT result_json FROM fills WHERE id IN ({','.join('?' * len(ids))}) ORDER BY rowid",
        ids,
    )
    return [json.loads(r[0]) for r in rows]


def _observations(ledger: PaperLedger, start: int, end: int | None) -> list[dict]:
    sql = "SELECT created_at, payload_json FROM observations WHERE created_at >= ?"
    args: list = [start]
    if end is not None:
        sql += " AND created_at < ?"
        args.append(end)
    return [json.loads(r[1]) for r in _rows(ledger, sql + " ORDER BY id", args)]


def _nav_near(ledger: PaperLedger, at: int, *, before: bool) -> Decimal | None:
    row = ledger.db.execute(
        "SELECT payload_json FROM observations WHERE created_at "
        + ("<= ? ORDER BY id DESC" if before else ">= ? ORDER BY id")
        + " LIMIT 1",
        (at,),
    ).fetchone()
    return _d((json.loads(row[0]).get("pnl") or {}).get("nav_usdt")) if row else None


def trade_row(fill: dict) -> dict:
    """One recorded fill, in human units, with the execution price it actually received."""
    route = fill["quote"]["route"]["tokens"]
    first, last = route[0], route[-1]
    amount_in = Decimal(fill["quote"]["amount_in_raw"]) / 10 ** first["decimals"]
    amount_out = Decimal(fill["amount_out_filled_raw"]) / 10 ** last["decimals"]
    side = "BUY" if first["asset_id"] == "USDT" else "SELL"
    asset = last["asset_id"] if side == "BUY" else first["asset_id"]
    quantity, notional = (amount_out, amount_in) if side == "BUY" else (amount_in, amount_out)
    origin = fill.get("origin") or {}
    return {
        "fill_id": fill["id"],
        "at": fill["created_at"],
        "side": side,
        "asset": asset,
        "quantity": _s(quantity),
        "notional_usdt": _s(notional),
        "price_usdt": _s(notional / quantity) if quantity else None,
        "realized_pnl_usdt": fill.get("realized_pnl_usdt"),
        "network_fee_usdt": fill.get("modeled_network_fee_usdt"),
        "strategy_id": origin.get("strategy_id"),
        "mode": fill.get("mode"),
        "receipt": fill.get("receipt"),
        "transaction_hash": fill.get("transaction_hash"),
        "block_number": fill["quote"].get("block_number"),
    }


def _round_trips(trades: list[dict], exit_reasons: dict[str, str]) -> list[dict]:
    """Pair each entry with the exits that closed it (per asset, in order)."""
    open_positions: dict[str, dict] = {}
    trips = []
    for trade in trades:
        asset = trade["asset"]
        if trade["side"] == "BUY":
            open_positions[asset] = {
                "asset": asset,
                "strategy_id": trade["strategy_id"],
                "entry_at": trade["at"],
                "entry_price_usdt": trade["price_usdt"],
                "cost_usdt": trade["notional_usdt"],
                "quantity": trade["quantity"],
                "exits": [],
                "realized_pnl_usdt": Decimal(0),
                "proceeds_usdt": Decimal(0),
            }
            continue
        position = open_positions.get(asset)
        if position is None:
            continue  # An exit of inventory opened before this session.
        position["exits"].append(trade)
        position["realized_pnl_usdt"] += _d(trade["realized_pnl_usdt"]) or Decimal(0)
        position["proceeds_usdt"] += _d(trade["notional_usdt"]) or Decimal(0)
        position["exit_at"] = trade["at"]
        position["exit_price_usdt"] = trade["price_usdt"]
        position["exit_reason"] = exit_reasons.get(trade["fill_id"])
        sold = sum((_d(e["quantity"]) or Decimal(0)) for e in position["exits"])
        if sold >= (_d(position["quantity"]) or Decimal(0)) * Decimal("0.999999"):
            position["closed"] = True
            trips.append(open_positions.pop(asset))
    trips.extend(open_positions.values())  # Still open (or closed after this window).
    result = []
    for trip in trips:
        cost = _d(trip["cost_usdt"]) or Decimal(0)
        closed = trip.get("closed", False)
        result.append(
            {
                "asset": trip["asset"],
                "strategy_id": trip["strategy_id"],
                "entry_at": trip["entry_at"],
                "entry_price_usdt": trip["entry_price_usdt"],
                "cost_usdt": trip["cost_usdt"],
                "quantity": trip["quantity"],
                "exit_at": trip.get("exit_at"),
                "exit_price_usdt": trip.get("exit_price_usdt"),
                "exit_reason": trip.get("exit_reason"),
                "status": "closed" if closed else "partial" if trip["exits"] else "open",
                "realized_pnl_usdt": _s(trip["realized_pnl_usdt"]) if closed else None,
                "return_pct": _s(trip["realized_pnl_usdt"] / cost * 100)
                if closed and cost
                else None,
                "holding_seconds": trip["exit_at"] - trip["entry_at"] if closed else None,
            }
        )
    return result


def _settings(start_payload: dict, fills: list[dict], fallback: dict) -> tuple[dict, str]:
    if start_payload.get("params"):
        return start_payload["params"], "recorded at session start"
    for fill in fills:
        params = (fill.get("execution_context") or {}).get("params")
        if params:
            return params, "recorded with this session's first fill"
    return fallback, "current settings (this older session did not record its own)"


def _price_at(observations: list[dict], at: int, asset: str) -> str | None:
    best = None
    for observation in observations:
        if observation.get("observed_at", 0) > at:
            break
        best = observation
    price = ((best or {}).get("markets") or {}).get(asset, {}).get("price")
    return _s(_d(price))


def _timeline(events: list[dict], fills: dict[str, dict], observations: list[dict]) -> list[dict]:
    """Readable story of the session: each trade appears once, carrying why it happened."""
    reasons: dict[str, dict] = {}
    for event in events:
        payload = event["payload"]
        if event["status"] == "library_evaluated" and payload.get("fill_id"):
            reasons[payload["fill_id"]] = {
                "strategy_id": payload.get("strategy_id"),
                "strategy_name": payload.get("strategy_name"),
                "why": payload.get("reason"),
                "confidence": payload.get("confidence"),
                "reference_price_usdt": _s(
                    _d((payload.get("inputs_snapshot") or {}).get("reference_price"))
                ),
            }
        elif event["status"] == "signal_executed" and payload.get("fill_id"):
            signal = payload.get("signal") or {}
            reasons[payload["fill_id"]] = {
                "strategy_id": "mean_reversion",
                "strategy_name": "Pool mean reversion",
                "why": signal.get("reason"),
                "confidence": None,
                "reference_price_usdt": None,
            }
        elif event["status"] == "exit_executed" and payload.get("fill_id"):
            reasons[payload["fill_id"]] = {
                "why": "Exit: " + str(payload.get("reason", "")).replace("_", " "),
            }
    items: list[dict] = []
    for event in events:
        status, payload, at = event["status"], event["payload"], event["created_at"]
        item = None
        if status == "control_changed":
            action = payload.get("action")
            if action == "resume":
                item = {
                    "kind": "start",
                    "title": "Agent started",
                    "detail": "Entries enabled; the agent monitors and trades on its own.",
                    "nav_usdt": payload.get("nav_usdt"),
                }
            elif action in STOP_ACTIONS:
                previous = items[-1] if items else None
                if (
                    previous
                    and previous["kind"] == "stop"
                    and at - previous["at"] <= PANIC_MERGE_SECONDS
                ):
                    if action == "panic":
                        previous.update(
                            title="PANIC stop",
                            detail="Entries blocked; open positions are unwound to USDT.",
                        )
                    continue
                item = {
                    "kind": "stop",
                    "title": STOP_ACTIONS[action],
                    "detail": "Entries blocked; open positions are unwound to USDT."
                    if action == "panic"
                    else "New entries blocked; protective exits stay active.",
                    "nav_usdt": payload.get("nav_usdt"),
                }
        elif status in {"paper_filled", "signed_filled"}:
            fill = fills.get(payload.get("fill_id"))
            if fill:
                trade = trade_row(fill)
                why = reasons.get(fill["id"], {})
                item = {
                    "kind": "buy" if trade["side"] == "BUY" else "sell",
                    "title": f"{'Bought' if trade['side'] == 'BUY' else 'Sold'} {trade['asset']}",
                    "detail": why.get("why"),
                    "asset": trade["asset"],
                    "quantity": trade["quantity"],
                    "notional_usdt": trade["notional_usdt"],
                    "price_usdt": trade["price_usdt"],
                    "market_price_usdt": _price_at(observations, at, trade["asset"]),
                    "reference_price_usdt": why.get("reference_price_usdt"),
                    "confidence": why.get("confidence"),
                    "realized_pnl_usdt": trade["realized_pnl_usdt"]
                    if trade["side"] == "SELL"
                    else None,
                    "strategy_id": trade["strategy_id"] or why.get("strategy_id"),
                    "strategy_name": why.get("strategy_name"),
                    "receipt": trade["receipt"],
                    "transaction_hash": trade["transaction_hash"],
                }
        elif status in {"exit_blocked", "circuit_breaker", "auto_derisk"}:
            item = {
                "kind": "risk",
                "title": {
                    "exit_blocked": "Exit blocked",
                    "circuit_breaker": "Circuit breaker tripped",
                    "auto_derisk": "Automatic de-risk",
                }[status],
                "detail": payload.get("reason") or payload.get("action"),
                "asset": payload.get("asset"),
            }
        elif status == "params_changed":
            item = {
                "kind": "settings",
                "title": "Settings changed",
                "detail": ", ".join(
                    f"{k.replace('_', ' ')}: {v.get('before')} → {v.get('after')}"
                    if isinstance(v, dict)
                    else k.replace("_", " ")
                    for k, v in sorted((payload.get("changes") or {}).items())
                )
                or None,
            }
        elif status in {"signed_skipped", "signed_reverted"}:
            item = {
                "kind": "risk",
                "title": "Signed trade skipped",
                "detail": payload.get("reason"),
            }
        if item:
            items.append({"id": event["id"], "at": at, **item})
    return items


def _series(observations: list[dict]) -> list[dict]:
    points = [
        {
            "at": o.get("observed_at"),
            "nav_usdt": (o.get("pnl") or {}).get("nav_usdt"),
            "prices": {a: m.get("price") for a, m in (o.get("markets") or {}).items()},
        }
        for o in observations
        if (o.get("pnl") or {}).get("nav_usdt") is not None
    ]
    if len(points) <= MAX_SERIES_POINTS:
        return points
    step = len(points) / MAX_SERIES_POINTS
    return [points[int(i * step)] for i in range(MAX_SERIES_POINTS - 1)] + [points[-1]]


def _start_nav(ledger: PaperLedger, session: dict) -> Decimal | None:
    """NAV when the session began: recorded at start, else the last observation before it.
    With no earlier observation and no earlier fill, the ledger still held its initial cash."""
    recorded = _d(session["start_payload"].get("nav_usdt"))
    if recorded is not None:
        return recorded
    before = _nav_near(ledger, session["started_at"], before=True)
    if before is not None:
        return before
    earlier_fill = ledger.db.execute(
        "SELECT 1 FROM decisions WHERE rowid < ? AND status IN ('paper_filled','signed_filled') LIMIT 1",
        (session["start_rowid"],),
    ).fetchone()
    if earlier_fill:
        return None
    identity = ledger.metadata("identity")
    identity = json.loads(identity) if isinstance(identity, str) else identity or {}
    initial = identity.get("initial_cash_raw")
    return Decimal(initial) / 10**ledger.stable.decimals if initial else None


def _summary(ledger: PaperLedger, session: dict, now: int, fills: list[dict]) -> dict:
    trades = [trade_row(f) for f in fills]
    realized = sum((_d(t["realized_pnl_usdt"]) or Decimal(0) for t in trades), Decimal(0))
    sells = [t for t in trades if t["side"] == "SELL"]
    start_nav = _start_nav(ledger, session)
    end_at = session["window_end_at"] or now
    end_nav = _nav_near(ledger, end_at, before=True)
    pnl = end_nav - start_nav if start_nav is not None and end_nav is not None else None
    running = session["ended_at"] is None
    return {
        "id": session["id"],
        "number": session["number"],
        "status": "running" if running else "ended",
        "started_at": session["started_at"],
        "ended_at": session["ended_at"],
        "end_reason": session["end_reason"],
        "end_label": END_REASONS.get(session["end_reason"]) if session["end_reason"] else "Running",
        "duration_seconds": (session["ended_at"] or now) - session["started_at"],
        "start_nav_usdt": _s(start_nav),
        "end_nav_usdt": _s(end_nav),
        "net_pnl_usdt": _s(pnl),
        "net_pnl_pct": _s(pnl / start_nav * 100) if pnl is not None and start_nav else None,
        "realized_pnl_usdt": _s(realized),
        "trades": len(trades),
        "entries": len(trades) - len(sells),
        "exits": len(sells),
        "wins": sum((_d(t["realized_pnl_usdt"]) or 0) > 0 for t in sells),
        "losses": sum((_d(t["realized_pnl_usdt"]) or 0) < 0 for t in sells),
        "assets": sorted({t["asset"] for t in trades}),
        "strategies": sorted({t["strategy_id"] for t in trades if t["strategy_id"]}),
    }


def list_sessions(ledger: PaperLedger, now: int) -> list[dict]:
    result = []
    for session in boundaries(ledger):
        ids = [
            e["payload"].get("fill_id")
            for e in _window(ledger, session, ("paper_filled", "signed_filled"))
        ]
        result.append(_summary(ledger, session, now, _fills(ledger, [i for i in ids if i])))
    return list(reversed(result))  # Newest first.


def session_detail(ledger: PaperLedger, session_id: str, now: int, current_params: dict) -> dict:
    session = next((s for s in boundaries(ledger) if s["id"] == session_id), None)
    if session is None:
        raise ValueError("Session not found")
    events = _window(ledger, session)
    fill_ids = [
        e["payload"].get("fill_id")
        for e in events
        if e["status"] in {"paper_filled", "signed_filled"} and e["payload"].get("fill_id")
    ]
    fills = _fills(ledger, fill_ids)
    by_id = {f["id"]: f for f in fills}
    exit_reasons = {
        e["payload"].get("fill_id"): str(e["payload"].get("reason", "")).replace("_", " ")
        for e in events
        if e["status"] == "exit_executed"
    }
    observations = _observations(ledger, session["started_at"], session["window_end_at"])
    trades = [trade_row(f) for f in fills]
    settings, settings_source = _settings(session["start_payload"], fills, current_params)
    evaluated = [e for e in events if e["status"] == "library_evaluated"]
    counts = {
        "strategy_evaluations": len(evaluated),
        "holds": sum(e["payload"].get("execution_status") == "HOLD" for e in evaluated),
        "blocked": sum(e["payload"].get("execution_status") == "BLOCKED" for e in evaluated),
        "signals_skipped": sum(e["status"] == "signal_skipped" for e in events),
        "risk_rejections": sum(e["status"] == "risk_rejected" for e in events),
        "market_checks": sum(e["status"] == "closed_loop" for e in events),
    }
    strategies: dict[str, dict] = {}
    trips = _round_trips(trades, exit_reasons)
    for trip in trips:
        row = strategies.setdefault(
            trip["strategy_id"] or "unattributed",
            {
                "strategy_id": trip["strategy_id"] or "unattributed",
                "positions": 0,
                "realized_pnl_usdt": Decimal(0),
            },
        )
        row["positions"] += 1
        row["realized_pnl_usdt"] += _d(trip["realized_pnl_usdt"]) or Decimal(0)
    return {
        **_summary(ledger, session, now, fills),
        "settings": {
            key: settings.get(key)
            for key in (
                "active_strategies",
                "target_assets",
                "risk_level",
                "position_size_pct",
                "position_size_usdt",
                "stop_loss_pct",
                "take_profit_pct",
                "trailing_stop_pct",
                "max_holding_seconds",
                "tick_seconds",
                "sizing_mode",
            )
        },
        "settings_source": settings_source,
        "positions": trips,
        "fills": trades,
        "strategy_breakdown": [
            {**row, "realized_pnl_usdt": _s(row["realized_pnl_usdt"])}
            for row in strategies.values()
        ],
        "activity": counts,
        "timeline": _timeline(events, by_id, observations),
        "series": _series(observations),
        "window_end_at": session["window_end_at"],
    }
