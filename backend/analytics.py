import math
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pandas as pd

from backend.models import Candle, Market, now


def aggregate(market: Market, timeframe: str):
    hours = {"1h": 1, "4h": 4, "1d": 24}[timeframe]
    if hours == 1:
        return market
    buckets = {}
    for candle in market.candles:
        bucket = int(candle.timestamp.timestamp()) // (hours * 3600) * hours * 3600
        buckets.setdefault(bucket, []).append(candle)
    result = []
    for bucket, bars in sorted(buckets.items()):
        start = datetime.fromtimestamp(bucket, timezone.utc)
        if (
            len(bars) != hours
            or bars[0].timestamp != start
            or any(b.timestamp != start + timedelta(hours=i) for i, b in enumerate(bars))
        ):
            continue
        result.append(
            Candle(
                timestamp=start,
                closed_at=bars[-1].closed_at,
                open=bars[0].open,
                high=max(b.high for b in bars),
                low=min(b.low for b in bars),
                close=bars[-1].close,
                volume=sum((b.volume for b in bars), Decimal(0)),
            )
        )
    return market.model_copy(
        update={
            "candles": result,
            "timeframe": timeframe,
            "as_of": result[-1].closed_at if result else None,
            "limitation": f"{timeframe} chart aggregates from complete consecutive hourly buckets only. Analysis indicators remain on the original hourly history. "
            + (market.limitation or ""),
        }
    )


def correlations(markets: dict[str, Market]):
    values = list(markets.values())
    if (
        len(values) < 2
        or any(m.status not in {"AVAILABLE", "FIXTURE"} for m in values)
        or len({m.source for m in values}) != 1
    ):
        return {
            "status": "UNAVAILABLE",
            "reason": "Need at least two available histories from one compatible source",
            "matrix": {},
        }
    frames = {
        m.asset.asset_id: pd.Series({bar.closed_at: float(bar.close) for bar in m.candles})
        for m in values
    }
    prices = pd.concat(frames, axis=1, join="inner").sort_index()
    returns = prices.pct_change(fill_method=None).dropna()
    if len(returns) < 60:
        return {
            "status": "UNAVAILABLE",
            "reason": "At least 60 aligned hourly return observations are required",
            "matrix": {},
        }
    matrix = returns.corr()
    return {
        "status": "FIXTURE" if all(m.status == "FIXTURE" for m in values) else "AVAILABLE",
        "source": values[0].source,
        "observations": len(returns),
        "from": returns.index[0].isoformat(),
        "as_of": returns.index[-1].isoformat(),
        "retrieved_at": now(),
        "matrix": {
            symbol: {
                other: float(matrix.loc[symbol, other])
                if math.isfinite(matrix.loc[symbol, other])
                else None
                for other in frames
            }
            for symbol in frames
        },
        "limitation": "Pearson correlation of aligned hourly returns; no forward fill. Descriptive, short-window evidence, not cointegration or an executable pairs strategy.",
    }
