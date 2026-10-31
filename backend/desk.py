"""Read-only desk calculations and one-shot price alerts. No execution authority."""

from decimal import ROUND_DOWN, Decimal
from typing import Literal

from pydantic import AwareDatetime, Field

from backend.models import Market, Model, Positive, RiskConfig, now, uid
from backend.storage import Store, encode


class AlertRequest(Model):
    symbol: Literal["BTC", "ETH", "SOL"]
    condition: Literal["ABOVE", "BELOW"]
    target: Positive = Field(le=Decimal("1000000000000"))


class PriceAlert(AlertRequest):
    id: str = Field(default_factory=uid)
    status: Literal["ARMED", "TRIGGERED"] = "ARMED"
    created_at: AwareDatetime = Field(default_factory=now)
    observed_at: AwareDatetime | None = None
    last_price: Positive | None = None
    source: str | None = None
    data_status: str | None = None
    triggered_at: AwareDatetime | None = None
    triggered_price: Positive | None = None


class PriceAlerts:
    """Persisted, audited notifications on observed crossings, never orders.

    Checked whenever the existing market ingestion refreshes. No background
    delivery is promised when both the desk and agent scheduler are stopped.
    A source change establishes a new baseline rather than inventing a crossing.
    """

    def __init__(self, store: Store):
        self.store = store
        store.config("desk_alerts", [])

    def _load(self):
        rows, version = self.store.config("desk_alerts", [])
        return [PriceAlert.model_validate(row) for row in rows], version

    def view(self):
        with self.store.lock:
            rows, version = self._load()
            return {"items": rows, "version": version, "total": len(rows)}

    def _save(self, rows, version):
        self.store.db.execute(
            "UPDATE config SET payload=?,version=? WHERE name='desk_alerts'",
            (encode(rows), version + 1),
        )

    def _valid(self, market: Market | None):
        if not market or market.status not in {"AVAILABLE", "FIXTURE"}:
            return False
        if market.price is None or market.price_at is None:
            return False
        if market.status == "FIXTURE":
            return True
        raw, _ = self.store.config("risk", RiskConfig().model_dump(mode="json"))
        max_age = min(120, RiskConfig.model_validate(raw).max_market_age_seconds)
        return -5 <= (now() - market.price_at).total_seconds() <= max_age

    def create(self, request: AlertRequest, markets: dict[str, Market]):
        with self.store.transaction():
            rows, version = self._load()
            if len(rows) >= 50:
                raise ValueError("At most 50 price alerts may be stored; remove an old alert first")
            alert = PriceAlert(**request.model_dump())
            market = markets.get(request.symbol)
            if self._valid(market):
                alert.last_price, alert.observed_at = market.price, market.price_at
                alert.source, alert.data_status = market.source, market.status
            rows.append(alert)
            self._save(rows, version)
            self.store.audit("price_alert.created", alert.model_dump(mode="json"))
            return alert

    def delete(self, identifier: str):
        with self.store.transaction():
            rows, version = self._load()
            remaining = [row for row in rows if row.id != identifier]
            if len(remaining) == len(rows):
                raise ValueError("Unknown price alert")
            self._save(remaining, version)
            self.store.audit("price_alert.deleted", {"id": identifier})
        return {"id": identifier, "deleted": True}

    def evaluate(self, markets: dict[str, Market]):
        with self.store.transaction():
            rows, version = self._load()
            changed = False
            for alert in rows:
                market = markets.get(alert.symbol)
                if alert.status != "ARMED" or not self._valid(market):
                    continue
                compatible = alert.source == market.source
                if compatible and alert.observed_at and market.price_at <= alert.observed_at:
                    continue
                previous = alert.last_price
                crossed = (
                    previous is not None
                    and compatible
                    and (
                        previous < alert.target <= market.price
                        if alert.condition == "ABOVE"
                        else previous > alert.target >= market.price
                    )
                )
                if crossed:
                    alert.status = "TRIGGERED"
                    alert.triggered_at, alert.triggered_price = now(), market.price
                    self.store.audit(
                        "price_alert.triggered",
                        {
                            **alert.model_dump(mode="json"),
                            "previous_price": str(previous),
                            "observed_at": market.price_at.isoformat(),
                            "source": market.source,
                            "data_status": market.status,
                            "action": "Notify only; no trade or exit submitted",
                        },
                    )
                elif alert.source and not compatible:
                    self.store.audit(
                        "price_alert.rebased", {"id": alert.id, "source": market.source}
                    )
                alert.last_price, alert.observed_at = market.price, market.price_at
                alert.source, alert.data_status = market.source, market.status
                changed = True
            if changed:
                self._save(rows, version)


def sizing_preview(portfolio, config: RiskConfig, symbol: str):
    """Decimal-safe sizing estimate. The independent final risk check still applies."""
    equity = Decimal(portfolio["equity"]) if portfolio["equity"] is not None else None
    quantum = Decimal("0.00000001")
    if equity is None or not portfolio["valuation_complete"]:
        cap, reason = Decimal(0), "Complete current portfolio marks are required"
    else:
        asset_value = Decimal(portfolio["asset_values"].get(symbol, 0))
        cap = max(
            Decimal(0),
            min(
                config.max_trade_notional,
                equity * config.max_equity_per_trade,
                Decimal(portfolio["cash"]),
                equity * config.max_asset_exposure - asset_value,
                equity * config.max_aggregate_exposure - Decimal(portfolio["exposure"]),
            ),
        )
        if not asset_value and len(portfolio["positions"]) >= config.max_positions:
            cap = Decimal(0)
        reason = "Sizing estimate only; fees, freshness, cooldowns and every risk check still apply"
    cap = cap.quantize(quantum, rounding=ROUND_DOWN)
    return {
        "symbol": symbol,
        "cap": cap,
        "presets": {
            key: (cap * fraction).quantize(quantum, rounding=ROUND_DOWN)
            for key, fraction in (
                ("25", Decimal("0.25")),
                ("50", Decimal("0.5")),
                ("max", Decimal(1)),
            )
        },
        "reason": reason,
        "as_of": portfolio.get("as_of"),
    }
