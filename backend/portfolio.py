from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from backend.models import Market, now
from backend.storage import Store

D = Decimal


class Portfolio:
    def __init__(self, store: Store):
        self.store = store
        self.initial, _ = store.config("simulation_capital", "10000")

    def view(self, markets: dict[str, Market]) -> dict:
        cash, fees, realized = D(self.initial), D(0), D(0)
        holdings = {}
        ledger = list(reversed(self.store.history("ledger", 100000)["items"]))
        for trade in ledger:
            symbol = trade["asset"]["asset_id"]
            slot = holdings.setdefault(symbol, {"quantity": D(0), "cost": D(0), "asset": trade["asset"], "exit_policy": trade["exit_policy"], "stop_price": trade["stop_price"]})
            quantity, notional = D(trade["quantity"]), D(trade["notional"])
            fee, network = D(trade["fee"]), D(trade["network_fee"])
            fees += fee + network
            if trade["side"] == "BUY":
                cash -= notional + network
                slot["quantity"] += quantity
                slot["cost"] += notional + network
                slot["exit_policy"], slot["stop_price"] = trade["exit_policy"], trade["stop_price"]
            else:
                if quantity > slot["quantity"] or slot["quantity"] <= 0:
                    raise ValueError("Ledger would create a short position")
                basis = slot["cost"] * quantity / slot["quantity"]
                net = notional - fee - network
                cash += net
                realized += net - basis
                slot["quantity"] -= quantity
                slot["cost"] -= basis
        positions, asset_values = [], {}
        valuation_complete = True
        unrealized, exposure = D(0), D(0)
        for symbol, slot in holdings.items():
            if slot["quantity"] <= D("0.000000000000000001"):
                continue
            market = markets.get(symbol)
            mark = market.price if market and market.status in {"AVAILABLE", "FIXTURE"} else None
            complete = mark is not None
            valuation_complete &= complete
            # Missing marks stay null. The risk engine rejects incomplete valuation.
            value = slot["quantity"] * mark if complete else None
            pnl = value - slot["cost"] if complete else None
            if value is not None:
                asset_values[symbol] = value
                exposure += value
                unrealized += pnl
            positions.append({"asset": slot["asset"], "quantity": slot["quantity"], "cost_basis": slot["cost"], "entry_price": slot["cost"] / slot["quantity"], "mark": mark, "price_at": market.price_at if market else None, "source": market.source if market else None, "value": value, "unrealized_pnl": pnl, "exit_policy": slot["exit_policy"], "stop_price": slot["stop_price"], "valuation_complete": complete, "mode": "SIMULATION"})
        equity = cash + exposure
        snapshots = list(reversed(self.store.history("snapshots", 100000)["items"]))
        highwater = max([D(self.initial), equity] + [D(row["equity"]) for row in snapshots])
        today = now().date()
        prior = [row for row in snapshots if datetime.fromisoformat(row["at"]).astimezone(timezone.utc).date() < today]
        day_start = D(prior[-1]["equity"]) if prior else D(self.initial)
        daily_return = (equity - day_start) / day_start if day_start else D(0)
        return {"mode": "SIMULATION", "initial_equity": self.initial, "cash": cash, "equity": equity if valuation_complete else None, "known_equity": equity, "exposure": exposure, "asset_values": asset_values, "realized_pnl": realized, "unrealized_pnl": unrealized if valuation_complete else None, "total_pnl": equity - D(self.initial) if valuation_complete else None, "daily_pnl": equity - day_start if valuation_complete else None, "daily_return": daily_return, "drawdown": (highwater - equity) / highwater if highwater else D(0), "fees": fees, "positions": positions, "valuation_complete": valuation_complete, "as_of": now(), "calculation": "Simulation cash + marked owned inventory. Average cost includes entry fees; realized P&L includes exit costs. Daily baseline is the last prior UTC-day mark, or initial capital before the first such mark.", "limitations": "Synthetic USD ledger; never a connected wallet valuation. Missing marks remain unavailable. External transfers and live transaction history are not imported."}

    def snapshot(self, markets):
        view = self.view(markets)
        if view["valuation_complete"]:
            self.store.snapshot({"at": now().isoformat(), "equity": str(view["equity"]), "mode": "SIMULATION", "source": "simulation_ledger", "positions": view["positions"]})
        return view
