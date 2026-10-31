"""Verified V3 pool state. No quote approximation, signing, or execution."""

from __future__ import annotations

from decimal import Decimal, localcontext
from pathlib import Path
from typing import Annotated

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from web3 import Web3

from aegis.connectors.rpc import BlockRef, DiscoveryError, ReadOnlyRpc

ROOT = Path(__file__).resolve().parents[2]
Address = Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]{40}$")]
ZERO = "0x" + "0" * 40


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ContractSpec(StrictModel):
    address: Address
    runtime_code_hash: str = Field(pattern=r"^0x[0-9a-fA-F]{64}$")


class TokenSpec(StrictModel):
    address: Address
    symbol: str
    decimals: int = Field(ge=0, le=36)


class PoolSpec(StrictModel):
    address: Address
    token0: str
    token1: str
    fee: int = Field(gt=0, lt=1_000_000)


class Network(StrictModel):
    chain_id: int
    rpc_urls: list[str] = Field(min_length=1, max_length=4)
    explorer: str
    subgraph: str
    amm: str = "uniswap_v3"
    max_block_age_seconds: int = Field(default=90, ge=10, le=300)
    confirmations: int = Field(default=2, ge=1, le=32)
    contracts: dict[str, ContractSpec]
    wrapped_native: str
    tokens: dict[str, TokenSpec]
    pools: list[PoolSpec]

    @field_validator("amm")
    @classmethod
    def v3_only(cls, value: str) -> str:
        if value != "uniswap_v3":
            raise ValueError("Phase 1 verifies the discovered V3 deployment only")
        return value

    @model_validator(mode="after")
    def coherent_registry(self) -> Network:
        if set(self.contracts) != {"factory", "router", "quoter"}:
            raise ValueError("Factory, router and quoter code pins are required")
        if self.wrapped_native not in self.tokens:
            raise ValueError("Wrapped native token must be in the verified token registry")
        for pool in self.pools:
            if pool.token0 not in self.tokens or pool.token1 not in self.tokens:
                raise ValueError("Every pool token must be in the verified registry")
            if pool.token0 == pool.token1:
                raise ValueError("A pool needs two distinct tokens")
        return self


def load_network(name: str = "mainnet", path: Path | None = None) -> Network:
    document = yaml.safe_load((path or ROOT / "config/networks.yaml").read_text())
    if document.get("schema_version") != 1:
        raise ValueError("Unsupported AEGIS network registry schema")
    if name not in document["networks"]:
        raise ValueError("Unknown network; choose mainnet or testnet")
    return Network.model_validate(document["networks"][name])


def mid_price(sqrt_price_x96: int, decimals0: int, decimals1: int) -> Decimal:
    """Human token1 per token0, including different token decimal scales."""
    if sqrt_price_x96 <= 0:
        raise DiscoveryError("Pool is uninitialized")
    with localcontext() as ctx:
        ctx.prec = 78
        return (
            Decimal(sqrt_price_x96) ** 2 / Decimal(2**192) * Decimal(10) ** (decimals0 - decimals1)
        )


class PoolSnapshot(StrictModel):
    address: Address
    token0: str
    token1: str
    fee_pips: int
    sqrt_price_x96: str
    tick: int
    active_liquidity_raw: str
    balance0_raw: str
    balance1_raw: str
    balance0: Decimal
    balance1: Decimal
    mid_token1_per_token0: Decimal
    balance_value_in_token1: Decimal
    unlocked: bool


class MarketSnapshot(StrictModel):
    chain_id: int
    block_number: int
    block_hash: str
    block_timestamp: int
    confirmations: int
    read_only: bool = True
    tokens: dict[str, TokenSpec]
    pools: list[PoolSnapshot]
    limitations: list[str] = [
        "Mid prices are not executable quotes; fees, tick crossings and gas are not included.",
        "ERC-20 pool balances are not V2 reserves or immediately available V3 liquidity.",
        "Balance value uses this pool's spot price; it is not an independent USD valuation.",
        "No transaction is signed or submitted. No strategy or profitability is measured.",
    ]


class HSKSwapData:
    def __init__(self, network: Network, rpc: ReadOnlyRpc | None = None):
        self.network = network
        self.rpc = rpc or ReadOnlyRpc(network.chain_id, network.rpc_urls)

    def close(self) -> None:
        self.rpc.close()

    def verify_contracts(self, block: BlockRef) -> None:
        n = self.network
        for role, spec in n.contracts.items():
            actual = Web3.keccak(self.rpc.code(spec.address, block)).to_0x_hex()
            if actual.lower() != spec.runtime_code_hash.lower():
                raise DiscoveryError(f"{role} runtime bytecode changed; repeat discovery")
        factory = n.contracts["factory"].address.lower()
        whsk = n.tokens[n.wrapped_native].address.lower()
        for role in ("router", "quoter"):
            address = n.contracts[role].address
            if self.rpc.call(address, "factory()", ["address"], block)[0].lower() != factory:
                raise DiscoveryError(f"{role} references another factory")
            if self.rpc.call(address, "WETH9()", ["address"], block)[0].lower() != whsk:
                raise DiscoveryError(f"{role} references another wrapped native token")
        if (
            self.rpc.call(n.contracts["router"].address, "factoryV2()", ["address"], block)[0]
            != ZERO
        ):
            raise DiscoveryError("V2 factory configuration changed; repeat discovery")
        for asset_id, token in n.tokens.items():
            self.rpc.code(token.address, block)
            decimals = self.rpc.call(token.address, "decimals()", ["uint8"], block)[0]
            symbol = self.rpc.call(token.address, "symbol()", ["string"], block)[0]
            if decimals != token.decimals or symbol != token.symbol:
                raise DiscoveryError(f"On-chain metadata mismatch for {asset_id}")

    def read_pool(self, pool: PoolSpec, block: BlockRef) -> PoolSnapshot:
        n = self.network
        t0, t1 = n.tokens[pool.token0], n.tokens[pool.token1]
        call = self.rpc.call
        self.rpc.code(pool.address, block)
        factory = call(pool.address, "factory()", ["address"], block)[0]
        token0 = call(pool.address, "token0()", ["address"], block)[0]
        token1 = call(pool.address, "token1()", ["address"], block)[0]
        fee = call(pool.address, "fee()", ["uint24"], block)[0]
        lookup = call(
            n.contracts["factory"].address,
            "getPool(address,address,uint24)",
            ["address"],
            block,
            types=["address", "address", "uint24"],
            args=[t0.address, t1.address, pool.fee],
        )[0]
        if (
            factory.lower() != n.contracts["factory"].address.lower()
            or token0.lower() != t0.address.lower()
            or token1.lower() != t1.address.lower()
            or fee != pool.fee
            or lookup.lower() != pool.address.lower()
        ):
            raise DiscoveryError("Pool identity does not match the verified factory registry")
        slot = call(
            pool.address,
            "slot0()",
            ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"],
            block,
        )
        liquidity = call(pool.address, "liquidity()", ["uint128"], block)[0]
        b0, b1 = [
            call(
                token.address,
                "balanceOf(address)",
                ["uint256"],
                block,
                types=["address"],
                args=[pool.address],
            )[0]
            for token in (t0, t1)
        ]
        with localcontext() as ctx:
            ctx.prec = 78
            price = mid_price(slot[0], t0.decimals, t1.decimals)
            balance0, balance1 = Decimal(b0) / 10**t0.decimals, Decimal(b1) / 10**t1.decimals
            return PoolSnapshot(
                address=pool.address,
                token0=pool.token0,
                token1=pool.token1,
                fee_pips=fee,
                sqrt_price_x96=str(slot[0]),
                tick=slot[1],
                active_liquidity_raw=str(liquidity),
                balance0_raw=str(b0),
                balance1_raw=str(b1),
                balance0=balance0,
                balance1=balance1,
                mid_token1_per_token0=price,
                balance_value_in_token1=balance0 * price + balance1,
                unlocked=slot[6],
            )

    def snapshot(self) -> MarketSnapshot:
        n = self.network
        block = self.rpc.block(
            confirmations=n.confirmations, max_age_seconds=n.max_block_age_seconds
        )
        self.verify_contracts(block)
        pools = [self.read_pool(p, block) for p in n.pools]
        self.rpc.assert_canonical(block)
        self.rpc.assert_fresh(block, n.max_block_age_seconds)
        return MarketSnapshot(
            chain_id=n.chain_id,
            block_number=block.number,
            block_hash=block.hash,
            block_timestamp=block.timestamp,
            confirmations=n.confirmations,
            tokens=n.tokens,
            pools=pools,
        )
