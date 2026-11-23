from datetime import datetime, timedelta
from decimal import Decimal

import httpx
import pytest

from backend.backtesting import RULE_WARMUP_HOURS, backtest_rules
from backend.data import fixture_market
from backend.models import BacktestAssumptions, RiskConfig, now
from backend.product.history import HistoricalBacktestRequest, load_candles
from backend.product.rules import StrategyDefinition
from backend.product.workflow import review_holdout


def test_coinbase_history_trimmed_across_requests_and_rejects_gaps():
    market = fixture_market("BTC", count=332)
    start = market.candles[RULE_WARMUP_HOURS].timestamp
    end = market.candles[-1].closed_at
    calls = []
    omit = False

    def respond(request):
        assert request.url.path.endswith("/products/BTC-USD/candles")
        assert request.url.params["granularity"] == "3600"
        first = datetime.fromisoformat(request.url.params["start"])
        last = datetime.fromisoformat(request.url.params["end"])
        calls.append((first, last))
        bars = [
            bar for bar in market.candles if first - timedelta(hours=1) <= bar.timestamp <= last
        ]
        if omit:
            bars = [bar for bar in bars if bar != market.candles[100]]
        return httpx.Response(
            200,
            json=[
                [
                    int(bar.timestamp.timestamp()),
                    str(bar.low),
                    str(bar.high),
                    str(bar.open),
                    str(bar.close),
                    str(bar.volume),
                ]
                for bar in reversed(bars)
            ],
        )

    transport = httpx.MockTransport(respond)
    result = load_candles("BTC", start, end, transport=transport)
    assert result.source == "coinbase_exchange"
    assert (result.venue, result.product_id, result.quote_currency) == (
        "coinbase_exchange",
        "BTC-USD",
        "USD",
    )
    assert result.candles == market.candles
    assert len(calls) == 2 and calls[0][1] == calls[1][0]
    omit = True
    with pytest.raises(ValueError, match="missing hours"):
        load_candles("BTC", start, end, transport=transport)
    with pytest.raises(ValueError, match="UTC offset"):
        load_candles("BTC", start.replace(tzinfo=None), end, transport=transport)
    with pytest.raises(ValueError, match="UTC hours"):
        load_candles("BTC", start + timedelta(seconds=1), end, transport=transport)
    next_hour = now().replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    with pytest.raises(ValueError, match="closed candle"):
        load_candles("BTC", start, next_hour, transport=transport)


def test_custom_replay_caps_costs_and_sizes_entries_against_available_cash():
    market = fixture_market("BTC")
    definition = StrategyDefinition.model_validate(
        {
            "asset": "BTC",
            "entry": {"conditions": [{"indicator": "price", "operator": "gt", "threshold": "1"}]},
            "exit": {"conditions": [{"indicator": "price", "operator": "lt", "threshold": "1"}]},
            "cash_fraction": "0.02",
            "stop_loss": "0.03",
            "take_profit": "0.001",
            "trailing_stop": "0.02",
        }
    )
    with pytest.raises(ValueError, match="costs exceed"):
        backtest_rules(market, BacktestAssumptions(fee_bps=100), definition, RiskConfig())
    request = BacktestAssumptions(initial_equity="1000", fee_bps=0, slippage_bps=0)
    risk = RiskConfig(max_equity_per_trade="0.05")
    result = backtest_rules(market, request, definition, risk)
    assert result == backtest_rules(market, request, definition, risk)
    sample = result["in_sample"]
    first, exit_trade, *_ = sample["trades"]
    assert (
        first["signal_at"] == first["at"] == market.candles[RULE_WARMUP_HOURS].timestamp.isoformat()
    )
    assert abs(Decimal(first["price"]) * Decimal(first["quantity"]) - 20) < Decimal("1e-20")
    assert exit_trade["reason"] == "entry-bar take-profit"
    assert sample["net_pnl"] and sample["exposure"] and sample["sharpe_ratio"]
    assert Decimal(sample["equity_history"][0]["drawdown"]) >= 0
    assert result["out_of_sample"]["from"] == sample["to"]


def test_backtest_request_rejects_incomplete_or_unaligned_windows():
    market = fixture_market("BTC")
    date = market.candles[0].timestamp
    for start, end in [
        (date, date + timedelta(hours=79)),
        (date, date + timedelta(days=15)),
        (date + timedelta(seconds=1), date + timedelta(days=5)),
    ]:
        with pytest.raises(ValueError):
            HistoricalBacktestRequest(version=1, start=start, end=end)


def test_position_cap_and_open_position_accounting_in_both_replay_windows():
    market = fixture_market("BTC")
    definition = StrategyDefinition.model_validate(
        {
            "asset": "BTC",
            "entry": {"conditions": [{"indicator": "price", "operator": "gt", "threshold": "1"}]},
            "exit": {"conditions": [{"indicator": "price", "operator": "lt", "threshold": "1"}]},
            "cash_fraction": "0.5",
            "max_position_usdt": "20",
            "stop_loss": "0.9",
        }
    )
    request = BacktestAssumptions(
        initial_equity="1000", fee_bps=10, slippage_bps=5, mar_annual_pct="5"
    )
    result = backtest_rules(market, request, definition, RiskConfig(max_equity_per_trade="0.05"))
    sample, holdout = result["in_sample"], result["out_of_sample"]
    assert sample["to"] == holdout["from"]
    assert sample["equity_history"][-1]["at"] < holdout["equity_history"][0]["at"]
    for window in (sample, holdout):
        [fill] = window["trades"]
        assert fill["side"] == "BUY" and fill["signal_at"] == window["from"]
        assert Decimal(fill["requested_budget"]) == 500
        assert Decimal(fill["effective_budget"]) == 20 and window["capped_entries"] == 1
        assert abs(
            Decimal(fill["price"]) * Decimal(fill["quantity"]) + Decimal(fill["fee"]) - 20
        ) < Decimal("1e-24")
        assert window["trade_count"] == 0 and Decimal(window["realized_pnl"]) == 0
        assert window["win_rate"] is None and window["profit_factor"] is None
        assert {"win_rate", "profit_factor"} <= window["metric_notes"].keys()
        open_position = window["open_position"]
        assert open_position["mark_at"] == window["to"]
        assert Decimal(open_position["cost_basis"]) == 20
        assert Decimal(open_position["market_value"]) + Decimal(window["ending_cash"]) == Decimal(
            window["ending_equity"]
        )
        estimate = window["end_of_window_liquidation_estimate"]
        assert Decimal(estimate["estimated_final_cash"]) < Decimal(window["ending_equity"])

        equity = [request.initial_equity] + [
            Decimal(row["equity"]) for row in window["equity_history"]
        ]
        returns = [after / before - 1 for before, after in zip(equity, equity[1:])]
        target = Decimal("1.05") ** (Decimal(1) / 8760) - 1
        excess = [value - target for value in returns]
        downside = (sum(min(value, 0) ** 2 for value in excess) / len(excess)).sqrt()
        expected_sortino = sum(excess) / len(excess) * Decimal(8760).sqrt() / downside
        assert Decimal(window["sortino_ratio"]) == pytest.approx(expected_sortino)

    approval = review_holdout({"report": {"result": result}})
    assert "Holdout contains no closed trades" in approval["reasons"]
