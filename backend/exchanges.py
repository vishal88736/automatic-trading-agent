from __future__ import annotations

import asyncio
from datetime import timedelta
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from typing import Protocol

import httpx

from backend.data import USD
from backend.models import Mode, Proposal, Quote, Token, now

D = Decimal
PRECISION = D("0.000000000000000001")
NETWORK_SOURCE = "https://docs.hskchain.net/docs/Build-on-HashKey-Chain/network-info"
TOKEN_SOURCE = "https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Token-Contracts"
HSK_TOKENS = {
    "WHSK": ("0xB210D2120d57b758EE163cFfb43e73728c471Cf1", "Wrapped HSK"),
    "WETH": ("0xefd4bC9afD210517803f293ABABd701CaeeCdfd0", "Bridged WETH"),
    "USDT": ("0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029", "Bridged USDT"),
    "WBTC": ("0x6119ca49a79f5825c8b345f8d7ac36b272565b14", "Bridged WBTC"),
    "USDC": ("0x054ed45810DbBAb8B27668922D110669c9D88D0a", "Bridged USDC"),
}


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

    async def quote(self, proposal: Proposal, notional: Decimal) -> Quote:
        if proposal.mode != Mode.SIMULATION:
            raise IntegrationUnavailable("Simulation adapter rejects other execution modes")
        fee = (notional * D("0.001")).quantize(PRECISION, rounding=ROUND_UP)
        impact = notional / D("1000000")
        price = proposal.reference_price * (
            D(1) + D("0.001") + impact if proposal.side == "BUY" else D(1) - D("0.001") - impact
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
        minimum = (output * D("0.999")).quantize(PRECISION, rounding=ROUND_UP)
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
            slippage_bps=10,
            price_impact=impact,
            network_fee_usd=D(0),
            trading_fee_usd=fee,
            liquidity_usd=D("1000000"),
            created_at=timestamp,
            expires_at=timestamp + timedelta(seconds=20),
            deadline=timestamp + timedelta(seconds=30),
            source="simulation_fill_model_v1",
            route=[
                "Simulated spot fill",
                "10 bps fee + 10 bps slippage + size/$1m impact; assumed liquidity; no blockchain",
            ],
        )

    async def transaction_status(self, tx_hash: str) -> dict:
        return {
            "status": "UNAVAILABLE",
            "reason": "Simulation receipts are persisted with the local intent; there is no blockchain transaction.",
        }


class HSKSwapAdapter:
    name = "hskswap"
    chain_id = 177
    rpc_url = "https://mainnet.hsk.xyz"
    explorer = "https://hashkey.blockscout.com"
    missing = [
        "On-chain token decimals and metadata validation against the documented registry",
        "Independently verified current router ABI and executable quote route",
        "Quote-to-calldata binding, allowance and L1+L2 fee validation",
        "Wallet signing authorization and receipt/balance reconciliation integration tests",
    ]

    def __init__(self, transport=None):
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
            "network_source": NETWORK_SOURCE,
            "token_source": TOKEN_SOURCE,
            "execution_enabled": False,
            "quote_enabled": False,
            "missing_requirements": self.missing,
            "tokens": [
                Token(
                    asset_id=symbol,
                    symbol=symbol,
                    name=name,
                    chain_id=177,
                    address=address,
                    kind="erc20",
                    metadata_source=TOKEN_SOURCE,
                ).model_dump(mode="json")
                for symbol, (address, name) in HSK_TOKENS.items()
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
        chain, balance, block = await asyncio.gather(
            self.rpc("eth_chainId", []),
            self.rpc("eth_getBalance", [address, "latest"]),
            self.rpc("eth_blockNumber", []),
        )
        if int(chain, 16) != self.chain_id:
            raise IntegrationUnavailable("RPC chain mismatch")
        return {
            "address": address,
            "chain_id": self.chain_id,
            "native_symbol": "HSK",
            "native_balance_raw": str(int(balance, 16)),
            "native_balance": str(D(int(balance, 16)) / D(10**18)),
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
