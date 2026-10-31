from datetime import timedelta
from decimal import Decimal

import httpx
import pytest
from pydantic import ValidationError

from backend.analytics import aggregate, chart_indicators
from backend.api import create_app
from backend.data import fixture_market
from backend.desk import AlertRequest, PriceAlerts, sizing_preview
from backend.models import Candle, RiskConfig, now
from backend.storage import Store
from backend.strategies import indicators
from backend.tests.test_strategy_risk import portfolio


def test_chart_series_match_analysis_and_do_not_use_future_bars():
    market = fixture_market("BTC")
    series = chart_indicators(market)
    latest = series.points[-1]
    measured = indicators(market)
    assert latest.rsi14 == pytest.approx(measured["rsi"])
    assert latest.macd == pytest.approx(measured["macd"])
    assert latest.signal == pytest.approx(measured["macd_signal"])
    prefix = market.model_copy(update={"candles": market.candles[:100]})
    assert chart_indicators(prefix).points == series.points[:100]
    assert all(point.rsi14 is None for point in series.points[:14])
    assert all(point.signal is None for point in series.points[:33])
    assert all(point.ema12 is None for point in series.points[:11])


@pytest.mark.parametrize("step,expected", [(0, 50), (1, 100), (-1, 0)])
def test_chart_rsi_flat_rising_and_falling(step, expected):
    market = fixture_market("BTC", 80)
    market.candles = [
        Candle(
            timestamp=bar.timestamp,
            closed_at=bar.closed_at,
            open=1000 + step * index,
            close=1000 + step * index,
            high=1001 + step * index,
            low=999 + step * index,
            volume=100,
        )
        for index, bar in enumerate(market.candles)
    ]
    assert chart_indicators(market).points[-1].rsi14 == expected


def test_chart_series_short_aggregated_gapped_and_stale_data():
    market = fixture_market("BTC")
    daily = chart_indicators(aggregate(market, "1d"))
    assert daily.timeframe == "1d" and len(daily.points) == 9
    assert all(point.rsi14 is None and point.macd is None for point in daily.points)
    market.candles.pop(40)
    assert chart_indicators(market).status == "UNAVAILABLE"
    assert all(point.ema12 is None for point in chart_indicators(market).points)
    market.status = "STALE"
    assert chart_indicators(market).status == "UNAVAILABLE"


def test_decimal_budget_respects_equity_asset_aggregate_cash_and_missing_marks():
    config = RiskConfig()
    result = sizing_preview(portfolio(), config, "BTC")
    assert result["cap"] == Decimal("100") and result["presets"]["25"] == Decimal("25")
    assert sizing_preview(portfolio(cash="0.123456789"), config, "BTC")["cap"] == Decimal(
        "0.12345678"
    )
    assert sizing_preview(portfolio(asset_values={"BTC": "995"}), config, "BTC")["cap"] == 5
    assert sizing_preview(portfolio(exposure="2999"), config, "BTC")["cap"] == 1
    assert (
        sizing_preview(portfolio(equity=None, valuation_complete=False), config, "BTC")["cap"] == 0
    )


def quote(price, at=0, source="synthetic_fixture_v1", status="FIXTURE"):
    market = fixture_market("BTC")
    return market.model_copy(
        update={
            "price": Decimal(str(price)),
            "price_at": market.price_at + timedelta(seconds=at),
            "source": source,
            "status": status,
        }
    )


def test_alert_crossing_is_persistent_one_shot_and_never_submits(tmp_path):
    path = str(tmp_path / "alerts.sqlite3")
    store = Store(path)
    alerts = PriceAlerts(store)
    created = alerts.create(
        AlertRequest(symbol="BTC", condition="ABOVE", target="101"), {"BTC": quote(100)}
    )
    alerts.evaluate({"BTC": quote(102, 1)})
    alerts.evaluate({"BTC": quote(103, 2)})
    assert alerts.view()["items"][0].status == "TRIGGERED"
    assert store.history("ledger")["total"] == store.history("intents")["total"] == 0
    assert (
        sum(row["kind"] == "price_alert.triggered" for row in store.history("audit")["items"]) == 1
    )
    store.close()
    reopened = Store(path)
    recovered = PriceAlerts(reopened)
    assert recovered.view()["items"][0].id == created.id
    assert recovered.view()["items"][0].triggered_price == Decimal(102)
    recovered.delete(created.id)
    assert recovered.view()["total"] == 0
    reopened.close()


def test_alert_ignores_stale_old_observations_and_rebases_provider_changes():
    store = Store(":memory:")
    alerts = PriceAlerts(store)
    alerts.create(AlertRequest(symbol="BTC", condition="BELOW", target="90"), {"BTC": quote(100)})
    alerts.evaluate({"BTC": quote(80, 1, status="STALE")})
    alerts.evaluate({"BTC": quote(80, -1)})
    assert alerts.view()["items"][0].status == "ARMED"
    alerts.evaluate({"BTC": quote(80, 2, source="another_fixture")})
    assert alerts.view()["items"][0].status == "ARMED"
    alerts.evaluate({"BTC": quote(100, 3, source="another_fixture")})
    alerts.evaluate({"BTC": quote(89, 4, source="another_fixture")})
    assert alerts.view()["items"][0].status == "TRIGGERED"
    store.close()


def test_alert_rejects_old_available_data_and_invalid_thresholds():
    store = Store(":memory:")
    alerts = PriceAlerts(store)
    market = quote(100, status="AVAILABLE")
    alert = alerts.create(
        AlertRequest(symbol="BTC", condition="ABOVE", target=101), {"BTC": market}
    )
    assert alert.last_price is None
    alerts.evaluate({"BTC": market.model_copy(update={"price": Decimal(103), "price_at": now()})})
    assert alerts.view()["items"][0].status == "ARMED"
    for value in ("NaN", "Infinity", "0", "-1", "1000000000001"):
        with pytest.raises(ValidationError):
            AlertRequest(symbol="BTC", condition="ABOVE", target=value)
    store.close()


async def test_desk_api_contracts_auth_and_alert_audit(tmp_path):
    app = create_app(
        str(tmp_path / "desk-api.sqlite3"), testing=True, api_token="desk-fixture-token"
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8787"
        ) as client:
            assert (
                await client.post(
                    "/api/alerts", json={"symbol": "BTC", "condition": "ABOVE", "target": "100000"}
                )
            ).status_code == 401
            client.headers["Authorization"] = "Bearer desk-fixture-token"
            budget = (await client.get("/api/desk/budget/BTC")).json()
            assert budget["presets"]["max"] == "100.00000000"
            detail = (await client.get("/api/markets/BTC?timeframe=4h")).json()
            assert detail["chart_indicators"]["timeframe"] == "4h"
            assert len(detail["chart_indicators"]["points"]) == len(detail["market"]["candles"])
            created = await client.post(
                "/api/alerts", json={"symbol": "BTC", "condition": "ABOVE", "target": "100000"}
            )
            assert created.status_code == 200
            assert (await client.get("/api/alerts")).json()["total"] == 1
            assert (await client.delete("/api/alerts/" + created.json()["id"])).json()["deleted"]
            assert (
                await client.post(
                    "/api/alerts", json={"symbol": "BTC", "condition": "ABOVE", "target": "NaN"}
                )
            ).status_code == 422
            audit = (await client.get("/api/history/audit")).json()["items"]
            assert any(row["kind"] == "price_alert.created" for row in audit)
