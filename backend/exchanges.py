from __future__ import annotations

import asyncio
from datetime import timedelta
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from typing import Protocol

import httpx

from backend.data import USD
from backend.models import Mode, Proposal, Quote, Token, now
from backend.settings import NetworkSettings, SimulationSettings, get_settings

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


class HSKSwapAdapter:
    name = "hskswap"
    missing = [
        "On-chain token decimals and metadata validation against the documented registry",
        "Independently verified current router ABI and executable quote route",
        "Quote-to-calldata binding, allowance and L1+L2 fee validation",
        "Wallet signing authorization and receipt/balance reconciliation integration tests",
    ]

    def __init__(self, transport=None, settings: NetworkSettings | None = None):
        self.settings = settings or get_settings().hsk
        self.chain_id, self.rpc_url, self.explorer = (
            self.settings.chain_id,
            self.settings.rpc_url,
            self.settings.explorer,
        )
        self.client = httpx.AsyncClient(
            timeout=8,
            transport=transport,
            follow_redirects=False,
            limits=httpx.Limits(max_connections=3),
        )
        self.semaphore = asyncio.Semaphore(3)
        self.sequence = 0

    async def close(self):
        await self.client.aclose()

    def configuration(self):
        return {
            "name": self.name,
            "chain_id": self.chain_id,
            "rpc_url": self.rpc_url,
            "explorer": self.explorer,
            "network_source": self.settings.network_source,
            "token_source": self.settings.token_source,
            "execution_enabled": False,
            "quote_enabled": False,
            "missing_requirements": self.missing,
            "tokens": [
                Token(
                    asset_id=symbol,
                    symbol=symbol,
                    name=token.name,
                    chain_id=self.chain_id,
                    address=token.address,
                    kind="erc20",
                    metadata_source=self.settings.token_source,
                ).model_dump(mode="json")
                for symbol, token in self.settings.tokens.items()
            ],
            "note": "Documented addresses; decimals and bytecode require RPC verification. Symbols are not interchangeable with CEX reference assets.",
        }

    async def rpc(self, method, params):
        if method not in {
            "eth_chainId",
            "eth_getBalance",
            "eth_getCode",
            "eth_call",
            "eth_getTransactionReceipt",
            "eth_blockNumber",
        }:
            raise IntegrationUnavailable("Only allowlisted read-only RPC methods are available")
        async with self.semaphore:
            self.sequence += 1
            response = await self.client.post(
                self.rpc_url,
                json={"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params},
            )
            response.raise_for_status()
            result = response.json()
            if "error" in result or "result" not in result:
                raise IntegrationUnavailable("RPC could not return verified data")
            return result["result"]

    async def wallet(self, address: str):
        import re

        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address) or int(address, 16) == 0:
            raise ValueError("Invalid wallet address")
        chain, block = await asyncio.gather(
            self.rpc("eth_chainId", []),
            self.rpc("eth_blockNumber", []),
        )
        if int(chain, 16) != self.chain_id:
            raise IntegrationUnavailable("RPC chain mismatch")
        balance = await self.rpc("eth_getBalance", [address, block])
        return {
            "address": address,
            "chain_id": self.chain_id,
            "native_symbol": self.settings.native_symbol,
            "native_balance_raw": str(int(balance, 16)),
            "native_balance": str(D(int(balance, 16)) / D(10**self.settings.native_decimals)),
            "block": int(block, 16),
            "retrieved_at": now(),
            "source": self.rpc_url,
            "read_only": True,
            "ownership_verified": False,
            "limitation": "Native balance only. No wallet ownership authentication, token history, or wallet P&L is inferred.",
        }

    async def quote(self, proposal: Proposal, notional: Decimal) -> Quote:
        raise IntegrationUnavailable("HSKSwap quoting disabled: " + "; ".join(self.missing))

    async def submit(self, intent_id: str, quote: Quote) -> str:
        raise IntegrationUnavailable(
            "Live execution is unavailable. No transaction was signed or submitted."
        )

    async def transaction_status(self, tx_hash: str):
        import re

        if not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx_hash):
            raise ValueError("Invalid transaction hash")
        if int(await self.rpc("eth_chainId", []), 16) != self.chain_id:
            raise IntegrationUnavailable("RPC chain mismatch")
        receipt = await self.rpc("eth_getTransactionReceipt", [tx_hash])
        return (
            {"status": "PENDING_OR_UNKNOWN"}
            if receipt is None
            else {
                "status": "CONFIRMED" if int(receipt["status"], 16) == 1 else "REVERTED",
                "block_number": int(receipt["blockNumber"], 16),
                "transaction_hash": tx_hash,
                "source": self.rpc_url,
                "balance_reconciled": False,
            }
        )


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
            "Alpaca brokerage execution is available only through the preserved legacy paper workflow; never used for HSKSwap."
        )
