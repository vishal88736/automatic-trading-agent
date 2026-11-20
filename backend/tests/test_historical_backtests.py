from datetime import datetime, timedelta
from decimal import Decimal

import httpx
import pytest

from backend.backtesting import RULE_WARMUP_HOURS, backtest_rules
from backend.data import fixture_market
from backend.historical_data import HistoricalBacktestRequest, load_candles
from backend.models import BacktestAssumptions, RiskConfig
from backend.strategy_rules import StrategyDefinition


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
    assert result.candles == market.candles
    assert len(calls) == 2 and calls[0][1] == calls[1][0]
    omit = True
    with pytest.raises(ValueError, match="missing hours"):
        load_candles("BTC", start, end, transport=transport)


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
