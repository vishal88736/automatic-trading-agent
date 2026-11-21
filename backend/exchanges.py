from __future__ import annotations

from datetime import timedelta
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from typing import Protocol

from backend.data import USD
from backend.models import Mode, Proposal, Quote, now
from backend.settings import SimulationSettings, get_settings

D = Decimal
PRECISION = D("0.000000000000000001")


class IntegrationUnavailable(ValueError):
    pass


class QuoteProvider(Protocol):
    async def quote(self, proposal: Proposal, notional: Decimal) -> Quote: ...


class SwapExecutor(Protocol):
    async def submit(self, intent_id: str, quote: Quote) -> str: ...


class TransactionStatusProvider(Protocol):
    async def transaction_status(self, tx_hash: str) -> dict: ...


class ExchangeAdapter(QuoteProvider, TransactionStatusProvider, Protocol):
    name: str


class SimulationAdapter:
    name = "simulation"

    def __init__(self, settings: SimulationSettings | None = None):
        self.settings = settings or get_settings().simulation

    def estimate_costs(self, notional: Decimal, side: str) -> Decimal:
        fee = notional * D(self.settings.fee_bps) / 10000
        drift = D(self.settings.slippage_bps) / 10000 + notional / self.settings.liquidity_usd
        shortfall = (
            notional - (notional - fee) / (1 + drift) if side == "BUY" else notional * drift + fee
        )
        return (shortfall + self.settings.network_fee_usd).quantize(PRECISION, rounding=ROUND_UP)

    async def quote(self, proposal: Proposal, notional: Decimal) -> Quote:
        if proposal.mode != Mode.SIMULATION:
            raise IntegrationUnavailable("Simulation adapter rejects other execution modes")
        fee = (notional * D(self.settings.fee_bps) / 10000).quantize(PRECISION, rounding=ROUND_UP)
        slippage = D(self.settings.slippage_bps) / 10000
        impact = notional / self.settings.liquidity_usd
        if slippage + impact >= 1:
            raise IntegrationUnavailable(
                "Notional exceeds the configured simulation liquidity model"
            )
        price = proposal.reference_price * (
            D(1) + slippage + impact if proposal.side == "BUY" else D(1) - slippage - impact
        )
        price = price.quantize(PRECISION)
        input_amount = (
            notional
            if proposal.side == "BUY"
            else proposal.exit_quantity
            if proposal.exit_quantity is not None and notional == proposal.notional
            else (notional / proposal.reference_price).quantize(PRECISION, rounding=ROUND_DOWN)
        )
        output = (
            (notional - fee) / price if proposal.side == "BUY" else input_amount * price - fee
        ).quantize(PRECISION, rounding=ROUND_DOWN)
        minimum = (output * (1 - slippage)).quantize(PRECISION, rounding=ROUND_UP)
        timestamp = now()
        return Quote(
            proposal_id=proposal.id,
            mode=Mode.SIMULATION,
            chain_id=None,
            input_token=USD if proposal.side == "BUY" else proposal.asset,
            output_token=proposal.asset if proposal.side == "BUY" else USD,
            input_amount=input_amount,
            output_amount=output,
            minimum_output=minimum,
            notional=notional,
            price=price,
            slippage_bps=self.settings.slippage_bps,
            price_impact=impact,
            network_fee_usd=self.settings.network_fee_usd,
            trading_fee_usd=fee,
            liquidity_usd=self.settings.liquidity_usd,
            created_at=timestamp,
            expires_at=timestamp + timedelta(seconds=self.settings.quote_ttl_seconds),
            deadline=timestamp + timedelta(seconds=self.settings.deadline_seconds),
            source="simulation_fill_model_v1",
            route=[
                "Simulated spot fill",
                f"{self.settings.fee_bps} bps fee + {self.settings.slippage_bps} bps slippage + size/{self.settings.liquidity_usd} USD impact; assumed liquidity; no blockchain",
            ],
        )

    async def transaction_status(self, tx_hash: str) -> dict:
        return {
            "status": "UNAVAILABLE",
            "reason": "Simulation receipts are persisted with the local intent; there is no blockchain transaction.",
        }



class AlpacaPaperAdapter:
    name = "alpaca_paper"

    def account(self):
        from tradingagents.dataflows.config import get_alpaca_use_paper

        if str(get_alpaca_use_paper()).lower() not in {"true", "1", "yes"}:
            raise IntegrationUnavailable(
                "Alpaca adapter requires an explicitly configured paper account"
            )
        from tradingagents.dataflows.alpaca_utils import AlpacaUtils

        return AlpacaUtils.get_account_info()

    async def quote(self, proposal, notional):
        raise IntegrationUnavailable(
            "Alpaca brokerage execution is available only through the preserved legacy paper workflow."
        )
