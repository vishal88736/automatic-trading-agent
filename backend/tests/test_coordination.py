from uuid import uuid4

import pytest

from backend.data import Providers
from backend.engine import Engine
from backend.models import RunRequest, StrategyConfig
from backend.storage import Store
from backend.strategies import REGISTRY


@pytest.mark.asyncio
async def test_research_opportunity_reaches_real_graph_and_cannot_replace_strategy_or_risk():
    store = Store(":memory:")
    engine = Engine(store, Providers(store, "fixture", "fixture"))
    evidence = {
        "opportunity_id": str(uuid4()),
        "source_agent_id": str(uuid4()),
        "symbol": "BTC",
        "signal": "BUY",
        "evidence": ["synthetic_fixture_v1"],
    }
    try:
        for identifier in REGISTRY:
            store.update_config(
                "strategy:" + identifier, StrategyConfig(enabled=False).model_dump(mode="json")
            )
        held = await engine.run(RunRequest(symbol="BTC"), external_evidence=[evidence])
        assert held["decision"] == "HOLD" and not held.get("proposal")
        assert held["research_evidence"] == [evidence]
        store.update_config("strategy:momentum_v1", StrategyConfig().model_dump(mode="json"))
        proposed = await engine.run(
            RunRequest(symbol="BTC", notional="1000"), external_evidence=[evidence]
        )
        assert proposed["decision"] == "BUY"
        assert "opportunity:" + evidence["opportunity_id"] in proposed["proposal"]["evidence"]
        assert proposed["risk"]["verdict"] == "REDUCED"
        assert proposed["intent"]["state"] == "AWAITING_AUTHORIZATION"
        assert not store.history("ledger")["items"]
    finally:
        await engine.close()
        store.close()
