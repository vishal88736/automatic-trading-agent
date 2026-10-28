from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
import math
from urllib.parse import urlsplit

import pandas as pd

from backend.models import Market, NewsFeed, Signal, StrategyConfig
from tradingagents.regime import RegimeConfig, classify_regime
from tradingagents.risk.position_sizing import compute_atr

REGISTRY = {
    "momentum_v1": {"name": "Trend & momentum", "description": "EMA alignment with MACD, RSI and participation confirmation.", "regime": "Trending", "required_data": ["80 consecutive closed hourly candles", "volume"], "entry": "Fast EMA > slow EMA, positive MACD, controlled RSI, confirmed volume", "exit": "EMA reversal, momentum invalidation or ATR stop", "provenance": "Adapts upstream technical brief EMA/RSI/MACD concepts, regime classifier and Wilder ATR."},
    "mean_reversion_v1": {"name": "Mean reversion", "description": "Bollinger displacement and RSI extremes in a constrained range.", "regime": "Ranging", "required_data": ["80 consecutive closed hourly candles"], "entry": "Below lower band, low RSI, no strong trend", "exit": "Reclaim rolling mean or ATR invalidation", "provenance": "Adapts upstream Bollinger/RSI indicators and regime filter; spot inventory only."},
    "news_aware_v1": {"name": "News-aware confirmation", "description": "Independent relevant stories confirmed by measured market momentum.", "regime": "Event driven", "required_data": ["market history", "2 independent timely news sources"], "entry": "Corroborated bullish evidence plus momentum confirmation", "exit": "Corroborated bearish evidence, market invalidation or ATR stop", "provenance": "New bounded news signal, grounded in normalized cryptocurrency.cv records."},
    "spread_research_v1": {"name": "Price-spread research", "description": "Requires compatible fresh two-leg executable routes and all-in net costs.", "regime": "Cross-venue research", "required_data": ["two compatible executable quotes", "fees", "gas", "settlement model"], "entry": "Disabled until verified routes exist", "exit": "Research only; no transactions", "provenance": "New research boundary. No invented spreads, cross-chain routes or performance."},
}


def indicators(market: Market) -> dict:
    bars = market.candles
    if len(bars) < 80:
        raise ValueError("At least 80 valid closed candles are required")
    if any(b.timestamp >= a.timestamp or abs((a.timestamp - b.timestamp).total_seconds() - 3600) > 1 for b, a in zip(bars, bars[1:])):
        raise ValueError("Candles must be unique and consecutive hourly bars")
    frame = pd.DataFrame([{k: float(getattr(b, k)) for k in ("open", "high", "low", "close", "volume")} for b in bars])
    close = frame.close
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    rsi = 50.0 if gain.iloc[-1] == loss.iloc[-1] == 0 else 100.0 if loss.iloc[-1] == 0 else float(100 - 100 / (1 + gain.iloc[-1] / loss.iloc[-1]))
    ema12, ema26 = close.ewm(span=12, adjust=False).mean(), close.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    average = float(close.tail(20).mean())
    std = float(close.tail(20).std(ddof=0))
    baseline = float(frame.volume.iloc[-21:-1].mean())
    atr = compute_atr(frame)
    if atr is None or baseline <= 0:
        raise ValueError("ATR or volume history is unavailable")
    # Upstream uses sqrt(252). Scale its absolute floor for hourly crypto, then correct the metric.
    annualization_ratio = math.sqrt(365 * 24 / 252)
    regime = classify_regime(frame, RegimeConfig(turbulent_abs_annual_vol_pct=40 / annualization_ratio), market.asset.symbol)
    metrics = {"price": float(close.iloc[-1]), "rsi": rsi, "ema_fast": float(ema12.iloc[-1]), "ema_slow": float(ema26.iloc[-1]), "sma50": float(close.tail(50).mean()), "macd": float(macd.iloc[-1]), "macd_signal": float(macd.ewm(span=9, adjust=False).mean().iloc[-1]), "atr": atr, "bb_lower": average - 2 * std, "bb_upper": average + 2 * std, "bb_mid": average, "support": float(frame.low.tail(20).min()), "resistance": float(frame.high.tail(20).max()), "volume_ratio": float(frame.volume.iloc[-1]) / baseline, "realized_vol_annualized": float(close.pct_change().tail(20).std()) * math.sqrt(8760), "trend_distance": abs(float(close.iloc[-1]) / float(close.tail(50).mean()) - 1), "trend": regime.trend_state, "regime": regime.label, "volatility": regime.volatility_state, "regime_risk_multiplier": regime.risk_multiplier, "annualization": "Hourly returns; sqrt(365*24). Descriptive estimate, not forecast.", "source": market.source, "as_of": market.as_of.isoformat()}
    if any(not math.isfinite(v) for v in metrics.values() if isinstance(v, float)):
        raise ValueError("Non-finite indicator")
    return metrics


def evaluate(strategy_id: str, market: Market, news: NewsFeed, config: StrategyConfig, holding=False, clock=None) -> Signal:
    timestamp = clock or market.as_of or market.retrieved_at
    base = {"strategy_id": strategy_id, "symbol": market.asset.symbol, "signal": "HOLD", "confidence": 0.0, "timestamp": timestamp, "rationale": "Entry conditions not met."}
    if not config.enabled or market.asset.symbol not in config.assets:
        return Signal(**{**base, "rationale": "Strategy disabled or asset excluded.", "risk_flags": ["DISABLED"]})
    if market.status in {"STALE", "UNAVAILABLE"}:
        return Signal(**{**base, "rationale": "Market data unavailable or stale.", "risk_flags": ["UNAVAILABLE_DATA"]})
    try:
        metrics = indicators(market)
    except ValueError as exc:
        return Signal(**{**base, "rationale": str(exc), "risk_flags": ["INSUFFICIENT_HISTORY"]})
    frame = pd.Series([float(b.close) for b in market.candles])
    fast = float(frame.ewm(span=config.fast_period, adjust=False).mean().iloc[-1])
    slow = float(frame.ewm(span=config.slow_period, adjust=False).mean().iloc[-1])
    bullish = fast > slow and metrics["macd"] > metrics["macd_signal"] and 45 < metrics["rsi"] < config.rsi_entry and metrics["volume_ratio"] >= config.volume_ratio
    bearish = fast < slow or metrics["rsi"] < config.rsi_exit
    evidence = [f"{market.source}:{market.as_of.isoformat()}", f"EMA {fast:.4f}/{slow:.4f}; RSI {metrics['rsi']:.2f}; volume {metrics['volume_ratio']:.2f}x"]
    enter, exit_signal, reason, flags = False, False, "", []
    if strategy_id == "momentum_v1":
        enter, exit_signal = bullish, bearish
        reason = "EMA, MACD, RSI and volume confirmed." if enter else "Momentum filters do not agree."
    elif strategy_id == "mean_reversion_v1":
        constrained = metrics["trend_distance"] <= config.max_trend_distance and metrics["volatility"] != "turbulent"
        enter = constrained and metrics["price"] < metrics["bb_lower"] and metrics["rsi"] < config.reversion_rsi
        exit_signal = metrics["price"] >= metrics["bb_mid"]
        reason = "Range displacement confirmed." if enter else "Range entry absent or trend/volatility filter blocks entry."
        if not constrained:
            flags.append("STRONG_TREND_OR_VOLATILITY")
    elif strategy_id == "news_aware_v1":
        articles = [a for a in news.articles if market.asset.symbol in a.assets and a.actionable_content and not a.stale and a.published_at is not None and a.available_at <= timestamp and a.published_at <= timestamp and timestamp - a.published_at <= timedelta(minutes=config.news_max_age_minutes) and (market.status == "FIXTURE") == a.fixture]
        positive = {urlsplit(a.url).hostname for a in articles if a.sentiment == "bullish"}
        negative = {urlsplit(a.url).hostname for a in articles if a.sentiment == "bearish"}
        evidence.extend(a.id for a in articles)
        enter = len(positive) >= config.news_min_sources and bullish and len(negative) == 0
        exit_signal = len(negative) >= config.news_min_sources and bearish
        reason = f"{len(positive)} bullish and {len(negative)} bearish independent source domains; market confirmation {'present' if bullish else 'absent'}. Headlines are untrusted evidence."
        if len(positive | negative) < config.news_min_sources:
            flags.append("INSUFFICIENT_CORROBORATION")
    elif strategy_id == "spread_research_v1":
        reason = "No verified compatible two-leg executable quotes. Net arbitrage cannot be established."
        flags.append("MISSING_EXECUTABLE_ROUTES")
    else:
        raise ValueError("Unknown strategy")
    action = "SELL" if holding and exit_signal else "BUY" if enter and not holding else "HOLD"
    return Signal(**{**base, "signal": action, "confidence": 0.65 if action != "HOLD" else 0.25, "entry_conditions_met": enter, "exit_conditions_met": exit_signal, "evidence": evidence, "risk_flags": flags, "rationale": reason, "stop_price": max(market.candles[-1].close * Decimal("0.8"), market.candles[-1].close - Decimal(str(metrics["atr"] * config.stop_atr_multiple)))})
