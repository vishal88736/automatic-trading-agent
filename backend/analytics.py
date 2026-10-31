import math
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pandas as pd
from pydantic import AwareDatetime

from backend.models import Candle, Market, Model, now


class ChartPoint(Model):
    timestamp: AwareDatetime
    ema12: float | None = None
    ema26: float | None = None
    rsi14: float | None = None
    macd: float | None = None
    signal: float | None = None
    histogram: float | None = None


class ChartIndicators(Model):
    source: str
    timeframe: str
    status: str
    reason: str | None = None
    method: str = "Causal pandas EWM; EMA 12/26, RSI alpha=1/14 adjust=False, MACD 12/26/9. Matches terminal analysis initialization; minimum periods are masked. Chart timeframe does not change hourly strategy analysis."
    points: list[ChartPoint]


def chart_indicators(market: Market):
    bars = market.candles
    points = [ChartPoint(timestamp=bar.timestamp) for bar in bars]
    result = ChartIndicators(
        source=market.source, timeframe=market.timeframe, status=market.status, points=points
    )
    seconds = {"1h": 3600, "4h": 14400, "1d": 86400}.get(market.timeframe)
    if (
        not bars
        or seconds is None
        or market.status not in {"AVAILABLE", "FIXTURE"}
        or any(
            (right.timestamp - left.timestamp).total_seconds() != seconds
            for left, right in zip(bars, bars[1:])
        )
    ):
        result.status = "UNAVAILABLE"
        result.reason = "Indicators require available, unique, consecutive closed chart bars"
        return result
    close = pd.Series([float(bar.close) for bar in bars])
    ema12, ema26 = close.ewm(span=12, adjust=False).mean(), close.ewm(span=26, adjust=False).mean()
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    macd = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    for index, point in enumerate(points):
        if index >= 11:
            point.ema12 = float(ema12.iloc[index])
        if index >= 25:
            point.ema26, point.macd = float(ema26.iloc[index]), float(macd.iloc[index])
        if index >= 33:
            point.signal = float(signal.iloc[index])
            point.histogram = float(macd.iloc[index] - signal.iloc[index])
        if index >= 14:
            average_gain, average_loss = float(gain.iloc[index]), float(loss.iloc[index])
            point.rsi14 = (
                50.0
                if average_gain == average_loss == 0
                else 100.0
                if average_loss == 0
                else 100 - 100 / (1 + average_gain / average_loss)
            )
    if len(bars) < 34:
        result.reason = "EMA12 needs 12 bars; EMA26/MACD 26; RSI14 15; MACD signal/histogram 34"
    return result


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
