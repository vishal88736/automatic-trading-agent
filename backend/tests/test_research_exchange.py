from decimal import Decimal

import httpx
import pytest
from langchain_core.messages import AIMessage

from backend.data import Providers, fixture_market
from backend.engine import Engine
from backend.exchanges import HSKSwapAdapter, IntegrationUnavailable
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


async def test_hsk_receipts_distinguish_pending_reverted_and_confirmed():
    receipt_status = [None, "0x0", "0x1"]

    async def handler(request):
        import json

        payload = json.loads(request.content)
        if payload["method"] == "eth_chainId":
            return httpx.Response(200, json={"result": "0xb1"})
        status = receipt_status.pop(0)
        return httpx.Response(
            200,
            json={"result": None if status is None else {"status": status, "blockNumber": "0x123"}},
        )

    adapter = HSKSwapAdapter(httpx.MockTransport(handler))
    tx_hash = "0x" + "a" * 64
    assert (await adapter.transaction_status(tx_hash))["status"] == "PENDING_OR_UNKNOWN"
    assert (await adapter.transaction_status(tx_hash))["status"] == "REVERTED"
    confirmed = await adapter.transaction_status(tx_hash)
    assert confirmed["status"] == "CONFIRMED" and not confirmed["balance_reconciled"]
    with pytest.raises(IntegrationUnavailable):
        await adapter.rpc("eth_sendTransaction", [])
    with pytest.raises(IntegrationUnavailable):
        await adapter.submit("fixture-intent", None)
    await adapter.close()


async def test_wrong_chain_wallet_and_missing_connection_remain_blocked():
    adapter = HSKSwapAdapter(
        httpx.MockTransport(lambda request: httpx.Response(200, json={"result": "0x1"}))
    )
    with pytest.raises(IntegrationUnavailable, match="chain mismatch"):
        await adapter.wallet("0x" + "1" * 40)
    with pytest.raises(ValueError):
        await adapter.wallet("")
    await adapter.close()


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
