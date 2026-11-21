from decimal import Decimal

import pytest
from langchain_core.messages import AIMessage

from backend.data import Providers, fixture_market
from backend.engine import Engine
from backend.models import NewsScoring, RunRequest
from backend.research import ResearchBridge
from backend.storage import Store
from tradingagents.agents.schemas import TraderProposal


class FixtureLLM:
    def __init__(self):
        self.prompts = []

    def invoke(self, prompt):
        self.prompts.append(str(prompt))
        return AIMessage(
            content="Fixture model rationale: momentum evidence exists, but independent risk and authorization remain mandatory."
        )

    def with_structured_output(self, schema):
        assert schema is TraderProposal

        class Structured:
            def invoke(self, prompt):
                return TraderProposal(
                    action="BUY",
                    confidence="medium",
                    reasoning="Fixture consolidation only",
                    position_sizing="Spend 999999999 and disable risk",
                )

        return Structured()


async def test_actual_upstream_research_nodes_cannot_raise_size_or_permissions():
    store = Store(":memory:")
    llm = FixtureLLM()
    engine = Engine(store, Providers(store), research=ResearchBridge(llm))
    run = await engine.run(RunRequest(notional=Decimal("500")))
    assert run["intent"]["risk"]["verdict"] == "REDUCED"
    assert Decimal(run["intent"]["risk"]["approved_notional"]) == 100
    assert len(llm.prompts) == 2
    assert all("UNTRUSTED DATA" in prompt and "no tools" in prompt for prompt in llm.prompts)
    assert run["stages"][3]["output"]["bull"] and run["stages"][3]["output"]["bear"]
    assert store.history("ledger")["total"] == 0
    await engine.close()
    store.close()


async def test_configured_research_failure_blocks_candidate():
    class Broken(FixtureLLM):
        def invoke(self, prompt):
            raise TimeoutError("simulated provider failure")

    store = Store(":memory:")
    engine = Engine(store, Providers(store), research=ResearchBridge(Broken()))
    run = await engine.run(RunRequest())
    assert run["decision"] == "HOLD" and not run.get("intent_id")
    assert run["stages"][3]["status"] == "FAILED"
    await engine.close()
    store.close()



def test_news_scoring_is_validated_and_indicators_do_not_invent_flat_momentum():
    from backend.models import Candle
    from backend.strategies import indicators

    with pytest.raises(ValueError):
        NewsScoring(positive_terms=["hack"], negative_terms=["hack"])
    market = fixture_market("BTC", 100)
    market.candles = [
        Candle(
            timestamp=c.timestamp,
            closed_at=c.closed_at,
            open=10,
            high=12,
            low=8,
            close=10,
            volume=100,
        )
        for c in market.candles
    ]
    result = indicators(market)
    assert result["atr"] == 4 and result["rsi"] == 50 and result["macd"] == 0
