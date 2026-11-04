"""Separate observed price movement from pool usability.

Unchanged sampled prices do not prove that no swaps occurred, nor that a fresh QuoterV2 call
cannot execute. Quiet prices and short history are informational. Locked pools and missing
active liquidity block entries; executable quotes and the normal risk checks remain mandatory.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

# Relative difference below which two recorded marks are the same pool state (rounding only).
SAME_PRICE = Decimal("1e-12")


def _moved(a: str, b: str) -> bool:
    try:
        x, y = Decimal(a), Decimal(b)
    except (InvalidOperation, TypeError):
        return a != b
    return abs(x - y) > SAME_PRICE * max(abs(x), abs(y))


def pool_activity(history: list[dict], markets: dict, now: int, window: int) -> dict[str, dict]:
    result = {}
    for asset, market in markets.items():
        observed = sorted(
            (o["observed_at"], o["markets"][asset]["price"])
            for o in history
            if asset in (o.get("markets") or {}) and o["observed_at"] <= now
        )
        recent = [p for p in observed if now - p[0] <= window]
        older = [p for p in observed if now - p[0] > window]
        # The last price seen before the window anchors how long the pool has been still.
        seq = older[-1:] + recent + [(now, market["price"])]
        j = len(seq) - 1
        while j > 0 and not _moved(seq[j - 1][1], seq[j][1]):
            j -= 1
        steady = now - seq[j][0]
        # Active only if a change provably happened inside the window: the earlier point of
        # that change is itself recent. A move before the window is not current activity.
        changes = [
            seq[i][0]
            for i in range(1, len(seq))
            if _moved(seq[i][1], seq[i - 1][1]) and now - seq[i - 1][0] <= window
        ]
        blocked = None
        if market.get("unlocked") is False:
            blocked = f"{asset} pool is locked; new entries wait for an unlocked pool"
        if "liquidity_raw" in market:
            try:
                if int(market["liquidity_raw"]) <= 0:
                    blocked = f"{asset} pool has no active liquidity"
            except (ValueError, TypeError):
                blocked = f"{asset} pool liquidity could not be verified"
        if blocked:
            status, reason = "unavailable", blocked
        elif changes:
            status, reason = "active", None
        elif steady >= window:
            status = "quiet"
            reason = (
                f"{asset} sampled price has not moved for at least {steady // 60} min. "
                "This does not prove zero swaps; fresh executable quotes and risk checks decide entries."
            )
        else:
            status = "warming"
            reason = (
                f"{asset} price history is collecting: {steady // 60} of {window // 60} min "
                "observed. Fresh executable quotes and risk checks still decide entries."
            )
        result[asset] = {
            "status": status,
            "reason": reason,
            "steady_seconds": steady,
            "last_change_at": changes[-1] if changes else (seq[j][0] if j > 0 else None),
            "price_changes": len(changes),
            "entry_blocked": blocked is not None,
            "evidence": "sampled_pool_prices",
        }
    return result
