"""Is a pool actually trading? Decided from recorded mid prices, never assumed.

An HSKSwap pool whose mid price has not moved over the window has had no swaps: an entry there
only pays the round-trip LP fee and price impact, and its mark (and so every stop-loss and
take-profit) cannot change. Such pools are blocked for new entries; exits are never blocked.
"""

from __future__ import annotations


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
        while j > 0 and seq[j - 1][1] == seq[j][1]:
            j -= 1
        steady = now - seq[j][0]
        # Active only if a change provably happened inside the window: the earlier point of
        # that change is itself recent. A move before the window is not current activity.
        changes = [
            seq[i][0]
            for i in range(1, len(seq))
            if seq[i][1] != seq[i - 1][1] and now - seq[i - 1][0] <= window
        ]
        if changes:
            status, reason = "active", None
        elif steady >= window:
            status = "inactive"
            reason = (
                f"{asset} pool price has not moved for at least {steady // 60} min (no swaps); "
                "entries there only pay fees and its stops cannot trigger"
            )
        else:
            status = "warming"
            reason = (
                f"{asset} pool activity not confirmed yet: no price change in "
                f"{steady // 60} of {window // 60} min observed"
            )
        result[asset] = {
            "status": status,
            "reason": reason,
            "steady_seconds": steady,
            "last_change_at": changes[-1] if changes else (seq[j][0] if j > 0 else None),
            "price_changes": len(changes),
        }
    return result
