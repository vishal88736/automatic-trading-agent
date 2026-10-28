from __future__ import annotations

from decimal import Decimal

from backend.models import BacktestRequest, Market, NewsFeed, RiskConfig
from backend.strategies import evaluate, indicators

D = Decimal


def backtest(market: Market, news: NewsFeed, request: BacktestRequest, strategy_config, risk: RiskConfig):
    if market.status not in {"AVAILABLE", "FIXTURE"} or len(market.candles) < 160:
        raise ValueError("At least 160 valid candles from an available source are required")
    indicators(market)  # Reject duplicate, unordered or missing intervals before accounting.
    split = max(81, int(len(market.candles) * (1 - request.holdout_fraction)))

    def segment(start, end):
        cash, units, basis, fees, stop = D("10000"), D(0), D(0), D(0), None
        peak = cash
        maximum_drawdown = D(0)
        trades, closed, curve = [], [], []
        day, day_equity = None, cash
        last_entry_index = None
        fee_rate, slip = D(request.fee_bps) / 10000, D(request.slippage_bps) / 10000
        for index in range(start, end):
            current, previous = market.candles[index], market.candles[index - 1]
            # Only previously closed candles and previously available articles may influence this order.
            history = market.model_copy(update={"candles": market.candles[:index], "price": previous.close, "price_at": previous.closed_at, "as_of": previous.closed_at})
            signal = evaluate(request.strategy_id, history, news, strategy_config, holding=units > 0, clock=previous.closed_at)
            opening_equity = cash + units * current.open
            if current.timestamp.date() != day:
                day, day_equity = current.timestamp.date(), opening_equity
            peak = max(peak, opening_equity)
            blocked = (peak - opening_equity) / peak >= risk.max_drawdown or (opening_equity - day_equity) / day_equity <= -risk.max_daily_loss
            hit_stop = units > 0 and stop is not None and current.low <= stop
            if units > 0 and (signal.signal == "SELL" or hit_stop):
                price = (min(current.open, stop) if hit_stop else current.open) * (1 - slip)
                gross = units * price
                fee = gross * fee_rate
                net = gross - fee
                pnl = net - basis
                cash += net
                fees += fee
                closed.append(pnl)
                trades.append({"side": "SELL", "at": current.timestamp.isoformat(), "quantity": str(units), "price": str(price), "fee": str(fee), "pnl": str(pnl), "reason": "standing ATR stop" if hit_stop else "strategy exit"})
                units, basis, stop = D(0), D(0), None
            elif not units and signal.signal == "BUY" and not blocked and (last_entry_index is None or (index - last_entry_index) * 3600 >= max(risk.cooldown_seconds, strategy_config.cooldown_seconds)):
                amount = min(cash, risk.max_trade_notional, opening_equity * risk.max_equity_per_trade, opening_equity * risk.max_asset_exposure, opening_equity * risk.max_aggregate_exposure)
                if amount >= 1:
                    price = current.open * (1 + slip)
                    fee = amount * fee_rate
                    units = (amount - fee) / price
                    cash -= amount
                    basis = amount
                    stop = signal.stop_price
                    fees += fee
                    last_entry_index = index
                    trades.append({"side": "BUY", "at": current.timestamp.isoformat(), "quantity": str(units), "price": str(price), "fee": str(fee), "signal_at": previous.closed_at.isoformat()})
            equity = cash + units * current.close
            peak = max(peak, equity)
            maximum_drawdown = max(maximum_drawdown, (peak - equity) / peak)
            curve.append({"at": current.closed_at.isoformat(), "equity": str(equity)})
        ending = cash + units * market.candles[end - 1].close
        gains = sum((p for p in closed if p > 0), D(0))
        losses = -sum((p for p in closed if p < 0), D(0))
        wins, loss_count = len([p for p in closed if p > 0]), len([p for p in closed if p < 0])
        days = (market.candles[end - 1].closed_at - market.candles[start].timestamp).total_seconds() / 86400
        benchmark = market.candles[end - 1].close / market.candles[start].open - 1
        return {"starting_equity": "10000", "ending_equity": str(ending), "total_return": str(ending / 10000 - 1), "annualized_return": str((float(ending / 10000) ** (365 / days)) - 1) if days >= 365 else None, "maximum_drawdown": str(maximum_drawdown), "trade_count": len(closed), "fill_count": len(trades), "win_rate": str(D(wins) / len(closed)) if closed else None, "profit_factor": str(gains / losses) if losses else None, "average_win": str(gains / wins) if wins else None, "average_loss": str(-losses / loss_count) if loss_count else None, "fees": str(fees), "sharpe_ratio": None, "benchmark_return": str(benchmark), "benchmark_note": "Unscaled buy-and-hold reference, excluding costs; strategy is cash-constrained and not risk-matched.", "open_quantity": str(units), "trades": trades, "equity_history": curve, "duration_days": days, "from": market.candles[start].timestamp.isoformat(), "to": market.candles[end - 1].closed_at.isoformat()}

    return {"mode": "SIMULATION", "source": market.source, "fixture": market.status == "FIXTURE", "strategy_id": request.strategy_id, "symbol": request.symbol, "parameters": strategy_config.model_dump(mode="json"), "risk_caps": risk.model_dump(mode="json"), "assumptions": {"fee_bps": request.fee_bps, "slippage_bps": request.slippage_bps, "network_fee": "0; no blockchain", "liquidity": "assumed sufficient; no DEX route", "execution": "Signal from prior closed bar; fill at next open. Standing stops fill at stop or worse opening gap with slippage.", "news": "Article publication AND availability must precede signal time. Current feeds cannot recreate historical knowledge.", "annualization": "Annualized return only after a full year; Sharpe omitted because its assumptions are unverified.", "survivorship": "Fixed BTC/ETH/SOL universe; not a market-wide survivorship-adjusted study.", "out_of_sample": "Chronological holdout, frozen parameters, fresh portfolio, past warm-up only; not a hyperparameter search."}, "in_sample": segment(80, split), "out_of_sample": segment(split, len(market.candles)), "limitation": "Development evaluation, not evidence of future profit. Simulated, paper and live results are never combined."}
