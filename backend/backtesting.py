from __future__ import annotations

from decimal import Decimal

from backend.models import (
    BacktestAssumptions,
    BacktestRequest,
    Market,
    NewsFeed,
    RiskConfig,
    StrategyConfig,
)
from backend.product.rules import StrategyDefinition, rule_signal
from backend.strategies import evaluate, indicators

D = Decimal
RULE_WARMUP_HOURS = 81


def backtest(
    market: Market, news: NewsFeed, request: BacktestRequest, strategy_config, risk: RiskConfig
):
    return _replay(market, request, risk, strategy_config, request.strategy_id, news)


def backtest_rules(
    market: Market, request: BacktestAssumptions, definition: StrategyDefinition, risk: RiskConfig
):
    if request.fee_bps > risk.max_trading_fee_bps or request.slippage_bps > risk.max_slippage_bps:
        raise ValueError("Backtest costs exceed the configured risk limits")
    return _replay(market, request, risk, definition, "custom_rules_v1")


def _replay(
    market: Market,
    request: BacktestAssumptions,
    risk: RiskConfig,
    strategy: StrategyConfig | StrategyDefinition,
    strategy_id: str,
    news: NewsFeed | None = None,
):
    rules = strategy if isinstance(strategy, StrategyDefinition) else None
    cooldown = (
        risk.cooldown_seconds if rules else max(risk.cooldown_seconds, strategy.cooldown_seconds)
    )
    warmup = RULE_WARMUP_HOURS if rules else 80
    if market.status not in {"AVAILABLE", "FIXTURE"} or len(market.candles) < 160:
        raise ValueError("At least 160 valid candles from an available source are required")
    indicators(market)  # Reject duplicate, unordered or missing intervals before accounting.
    sample_start = warmup if rules else 0
    split = max(
        warmup + 1,
        sample_start + int((len(market.candles) - sample_start) * (1 - request.holdout_fraction)),
    )

    def segment(start, end):
        cash, units, basis, fees = request.initial_equity, D(0), D(0), D(0)
        stop, target = None, None
        peak = cash
        maximum_drawdown = D(0)
        trades, closed, curve = [], [], []
        durations, hourly_returns = [], []
        exposed_hours = 0
        prior_equity = cash
        opened_at = None
        day, day_equity = None, cash
        last_entry_index = None
        fee_rate, slip = D(request.fee_bps) / 10000, D(request.slippage_bps) / 10000

        def close_position(at, raw_price, reason):
            nonlocal units, cash, basis, fees, stop, target, opened_at
            price = raw_price * (1 - slip)
            gross = units * price
            fee = gross * fee_rate
            net = gross - fee
            pnl = net - basis
            cash += net
            fees += fee
            closed.append(pnl)
            durations.append(int((at - opened_at).total_seconds()))
            trades.append(
                {
                    "side": "SELL",
                    "at": at.isoformat(),
                    "quantity": str(units),
                    "price": str(price),
                    "fee": str(fee),
                    "pnl": str(pnl),
                    "reason": reason,
                }
            )
            units, basis, stop, target, opened_at = D(0), D(0), None, None, None

        for index in range(start, end):
            current, previous = market.candles[index], market.candles[index - 1]
            exposed_this_hour = units > 0
            # Only previously closed candles and previously available articles may influence this order.
            history = market.model_copy(
                update={
                    "candles": market.candles[:index],
                    "price": previous.close,
                    "price_at": previous.closed_at,
                    "as_of": previous.closed_at,
                }
            )
            if rules:
                side = rule_signal(rules, history, holding=units > 0)
                entry_price = current.open * (1 + slip)
                entry_stop = entry_price * (1 - rules.stop_loss)
                if rules.trailing_stop is not None:
                    entry_stop = max(entry_stop, entry_price * (1 - rules.trailing_stop))
            else:
                signal = evaluate(
                    strategy_id,
                    history,
                    news,
                    strategy,
                    holding=units > 0,
                    clock=previous.closed_at,
                )
                side, entry_stop = signal.signal, signal.stop_price
            opening_equity = cash + units * current.open
            if current.timestamp.date() != day:
                day, day_equity = current.timestamp.date(), opening_equity
            peak = max(peak, opening_equity)
            blocked = (peak - opening_equity) / peak >= risk.max_drawdown or (
                opening_equity - day_equity
            ) / day_equity <= -risk.max_daily_loss
            hit_stop = units > 0 and stop is not None and current.low <= stop
            hit_target = units > 0 and target is not None and current.high >= target
            # A rule exit is decided before the opening fill. Standing exits gapped at the
            # open also fill there. For ambiguous intrabar protection, use the adverse stop.
            if rules and units > 0 and side == "SELL":
                close_position(current.timestamp, current.open, "strategy exit")
            elif hit_stop and (not hit_target or current.open < target):
                close_position(
                    current.timestamp,
                    min(current.open, stop),
                    "standing stop" if rules else "standing ATR stop",
                )
            elif hit_target:
                close_position(current.timestamp, max(current.open, target), "take-profit")
            elif units > 0 and side == "SELL":
                close_position(current.timestamp, current.open, "strategy exit")
            elif (
                not units
                and side == "BUY"
                and not blocked
                and entry_stop is not None
                and (rules is not None or current.open > entry_stop)
                and (last_entry_index is None or (index - last_entry_index) * 3600 >= cooldown)
            ):
                amount = min(
                    cash * rules.cash_fraction if rules else cash,
                    risk.max_trade_notional,
                    opening_equity * risk.max_equity_per_trade,
                    opening_equity * risk.max_asset_exposure,
                    opening_equity * risk.max_aggregate_exposure,
                )
                if amount >= 1:
                    price = current.open * (1 + slip)
                    fee = amount * fee_rate
                    units = (amount - fee) / price
                    cash -= amount
                    basis = amount
                    stop = entry_stop
                    opened_at = current.timestamp
                    exposed_this_hour = True
                    if rules and rules.take_profit is not None:
                        target = price * (1 + rules.take_profit)
                    fees += fee
                    last_entry_index = index
                    trades.append(
                        {
                            "side": "BUY",
                            "at": current.timestamp.isoformat(),
                            "quantity": str(units),
                            "price": str(price),
                            "fee": str(fee),
                            "signal_at": previous.closed_at.isoformat(),
                        }
                    )
                    if current.low <= stop:
                        close_position(
                            current.timestamp,
                            min(current.open, stop) if rules else stop,
                            "entry-bar stop"
                            if rules
                            else "entry-bar ATR stop; exact intrabar time unknown",
                        )
                    elif target is not None and current.high >= target:
                        close_position(current.timestamp, target, "entry-bar take-profit")
            if units > 0 and rules and rules.trailing_stop is not None:
                # Ratchet only for a subsequent candle; the path within this candle is unknown.
                stop = max(stop, current.high * (1 - rules.trailing_stop))
            equity = cash + units * current.close
            peak = max(peak, equity)
            drawdown = (peak - equity) / peak
            maximum_drawdown = max(maximum_drawdown, drawdown)
            curve.append(
                {
                    "at": current.closed_at.isoformat(),
                    "equity": str(equity),
                    "drawdown": str(drawdown),
                }
            )
            exposed_hours += exposed_this_hour
            hourly_returns.append(equity / prior_equity - 1)
            prior_equity = equity
        ending = cash + units * market.candles[end - 1].close
        gains = sum((p for p in closed if p > 0), D(0))
        losses = -sum((p for p in closed if p < 0), D(0))
        wins, loss_count = len([p for p in closed if p > 0]), len([p for p in closed if p < 0])
        days = (
            market.candles[end - 1].closed_at - market.candles[start].timestamp
        ).total_seconds() / 86400
        benchmark = market.candles[end - 1].close / market.candles[start].open - 1
        mean_return = sum(hourly_returns) / len(hourly_returns)
        return_variance = sum((value - mean_return) ** 2 for value in hourly_returns) / len(
            hourly_returns
        )
        downside_variance = sum(min(value, D(0)) ** 2 for value in hourly_returns) / len(
            hourly_returns
        )
        annualized_mean = mean_return * D(8760).sqrt()
        return {
            "starting_equity": str(request.initial_equity),
            "ending_equity": str(ending),
            "total_return": str(ending / request.initial_equity - 1),
            "net_pnl": str(ending - request.initial_equity),
            "annualized_return": str((float(ending / request.initial_equity) ** (365 / days)) - 1)
            if days >= 365
            else None,
            "maximum_drawdown": str(maximum_drawdown),
            "trade_count": len(closed),
            "fill_count": len(trades),
            "win_rate": str(D(wins) / len(closed)) if closed else None,
            "profit_factor": str(gains / losses) if losses else None,
            "average_win": str(gains / wins) if wins else None,
            "average_loss": str(-losses / loss_count) if loss_count else None,
            "average_trade_duration_seconds": str(sum(durations) / D(len(durations)))
            if durations
            else None,
            "exposure": str(D(exposed_hours) / (end - start)),
            "fees": str(fees),
            "sharpe_ratio": str(annualized_mean / return_variance.sqrt())
            if rules and return_variance
            else None,
            "sortino_ratio": str(annualized_mean / downside_variance.sqrt())
            if rules and downside_variance
            else None,
            "benchmark_return": str(benchmark),
            "benchmark_note": "Unscaled buy-and-hold reference, excluding costs; strategy is cash-constrained and not risk-matched.",
            "open_quantity": str(units),
            "trades": trades,
            "equity_history": curve,
            "duration_days": days,
            "from": market.candles[start].timestamp.isoformat(),
            "to": market.candles[end - 1].closed_at.isoformat(),
        }

    return {
        "mode": "SIMULATION",
        "source": market.source,
        "fixture": market.status == "FIXTURE",
        "strategy_id": strategy_id,
        "symbol": market.asset.symbol,
        "parameters": strategy.model_dump(mode="json"),
        "risk_caps": risk.model_dump(mode="json"),
        "assumptions": {
            "fee_bps": request.fee_bps,
            "slippage_bps": request.slippage_bps,
            "network_fee": "0; no blockchain",
            "liquidity": "assumed sufficient; no DEX route",
            "execution": "Signal from prior closed bar; fill at next open. Standing stops fill at stop or worse opening gap with slippage.",
            "protections": "Fixed loss, optional trailing and take-profit triggers use hourly OHLC. An ambiguous bar uses the adverse stop unless the target was reached at the open."
            if rules
            else "Standing ATR stop",
            "news": "No news inputs"
            if rules
            else "Article publication AND availability must precede signal time. Current feeds cannot recreate historical knowledge.",
            "annualization": "Hourly ratios use zero reference return and 8760 hours/year. Undefined ratios are null. Annualized return requires a full year."
            if rules
            else "Annualized return only after a full year; Sharpe omitted because its assumptions are unverified.",
            "trade_timing": "Duration uses bar timestamps. Exposure counts hours with any modeled holding, including entry and exit bars.",
            "survivorship": "Fixed BTC/ETH/SOL universe; not a market-wide survivorship-adjusted study.",
            "out_of_sample": "Chronological holdout, frozen parameters, fresh portfolio, past warm-up only; not a hyperparameter search.",
        },
        "in_sample": segment(warmup, split),
        "out_of_sample": segment(split, len(market.candles)),
        "limitation": "Development evaluation, not evidence of future profit. Simulated, paper and live results are never combined.",
    }
