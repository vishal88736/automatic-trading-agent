"""Deterministic fixture connector for tests only. The CLI never imports this module."""

from __future__ import annotations

import json
import time
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

from web3 import Web3

from aegis.connectors.base import Route
from aegis.connectors.hskswap_v3 import HSKSwapConnector
from aegis.data import MarketSnapshot, load_network


class MockConnector(HSKSwapConnector):
    name = "fixture_only"

    def __init__(self, *, impact_bps: int = 5):
        class FixtureRpc:
            def assert_canonical(self, block):
                pass

            def assert_fresh(self, block, max_age_seconds):
                if int(time.time()) - block.timestamp > max_age_seconds:
                    raise ValueError("Fixture is stale")

        super().__init__(
            load_network(), reader=SimpleNamespace(rpc=FixtureRpc(), close=lambda: None)
        )
        root = Path(__file__).resolve().parents[3]
        raw = json.loads((root / "docs/evidence/aegis-prices-177.json").read_text())
        raw.pop("observed_at")
        raw["block_timestamp"] = int(time.time()) - 4
        raw["block_hash"] = Web3.keccak(
            text=f"aegis-fixture-block-{raw['block_timestamp']}"
        ).to_0x_hex()
        self._fixture = MarketSnapshot.model_validate(raw)
        self.impact_bps = impact_bps

    def market(self):
        return self._fixture

    def refresh(self):
        return self.market()

    def _raw_quote(self, route: Route, amount_in: int, block):
        states = tuple(self.get_pool_state(p) for p in route.pools)
        value = (
            Decimal(amount_in)
            / 10 ** route.tokens[0].decimals
            * self.route_mid(route, states)
            * 10 ** route.tokens[-1].decimals
        )
        for pool in route.pools:
            value *= 1 - Decimal(pool.fee_pips) / 1_000_000
        return int(value * (1 - Decimal(self.impact_bps) / 10000)), 75000 * len(route.pools)
