"""Paper execution terms applied to live quotes; never sends a transaction."""

from __future__ import annotations

from decimal import Decimal

from pydantic import Field

from aegis.connectors.base import (
    DexConnector,
    Pool,
    PoolState,
    Price,
    Quote,
    Route,
    SimResult,
    Token,
    TxRequest,
)
from aegis.data import StrictModel


class PaperTerms(StrictModel):
    extra_slippage_bps: int = Field(default=10, ge=0, le=50)
    network_fee_usdt: Decimal = Field(default=Decimal("0.01"), ge=0, le=10)
    disclosure: str = "LP fees included by QuoterV2; additional slippage is modeled; network fee is a configurable USDT expense model, not measured chain gas."


class PaperConnector:
    name = "paper"

    def __init__(self, live: DexConnector, terms: PaperTerms | None = None):
        self.live = live
        self.chain_id = live.chain_id
        self.terms = terms or PaperTerms()

    def list_pools(self) -> list[Pool]:
        return self.live.list_pools()

    def get_price(self, base: Token, quote: Token) -> Price:
        return self.live.get_price(base, quote)

    def get_quote(self, token_in: Token, token_out: Token, amount_in: int) -> Quote:
        return self.live.get_quote(token_in, token_out, amount_in)

    def find_routes(self, token_in: Token, token_out: Token, max_hops: int = 3) -> list[Route]:
        return self.live.find_routes(token_in, token_out, max_hops)

    def simulate_swap(self, route: Route, amount_in: int, min_out: int) -> SimResult:
        return self.live.simulate_swap(route, amount_in, min_out)

    def build_swap_tx(
        self, route: Route, amount_in: int, min_out: int, deadline: int, recipient: str
    ) -> TxRequest:
        return self.live.build_swap_tx(route, amount_in, min_out, deadline, recipient)

    def get_pool_state(self, pool: Pool) -> PoolState:
        return self.live.get_pool_state(pool)

    def fill_amount(self, quote: Quote) -> int:
        return quote.amount_out_raw * (10000 - self.terms.extra_slippage_bps) // 10000
