from decimal import Decimal
from types import SimpleNamespace

import pytest

from backend.cloud_worker import CloudWorker, control_scalars, risk_adapter
from backend.models import RiskConfig


def test_cloud_policy_cannot_relax_python_risk_invariants():
    policy = {
        "maxTradeNotional": "100",
        "maxRiskPerTrade": 0.005,
        "maxDailyLoss": 0.03,
        "maxPortfolioExposure": 0.2,
        "maxAssetExposure": 0.1,
        "maxConcurrentPositions": 3,
        "slippageBps": 30,
        "maxPriceImpact": 0.005,
        "minimumLiquidity": "50000",
        "maxNetworkFee": "2",
        "maxDrawdown": 0.1,
        "cooldownSeconds": 300,
    }
    result = risk_adapter(policy)
    assert result.max_equity_per_trade == Decimal("0.005")
    assert result.emergency_policy == "HOLD_AND_REVIEW"
    assert result.max_quote_age_seconds == RiskConfig().max_quote_age_seconds
    with pytest.raises(ValueError):
        risk_adapter({**policy, "maxDailyLoss": 1})


def test_boto_control_numbers_do_not_break_scheduling_or_model_scoring_and_money_stays_exact():
    native = control_scalars(
        {
            "monitoringInterval": Decimal(300),
            "confidence": Decimal("0.6"),
            "riskPolicy": {
                "maxRiskPerTrade": Decimal("0.005"),
                "maxTradeNotional": "100.000000000000000001",
            },
            "items": [Decimal(1)],
        }
    )
    assert 0.25 + native["monitoringInterval"] == 300.25
    assert min(1.0, native["confidence"]) == 0.6
    assert native["riskPolicy"]["maxTradeNotional"] == "100.000000000000000001"
    assert native["items"] == [1]
    with pytest.raises(ValueError):
        control_scalars(Decimal("NaN"))


def test_worker_rechecks_active_version_stop_budget_and_lease_before_any_fill():
    worker = CloudWorker.__new__(CloudWorker)
    worker.pk, worker.deployment, worker.owner = "tenant-fixture", "deployment-one", "worker-one"
    worker.tenant = "tenant-fixture"
    policy = {"emergency": False}
    worker.control_table = SimpleNamespace(get_item=lambda **_: {"Item": policy})
    import time

    control = {
        "activeDeployment": "deployment-one",
        "desired": "RUN",
        "expiresAt": int(time.time()) + 300,
    }
    lease = {"leaseOwner": "worker-one", "expiresAt": int(time.time()) + 120}
    worker.control = lambda: control
    worker.state = SimpleNamespace(get_item=lambda **_: {"Item": lease})
    assert worker.execution_permitted()
    policy["emergency"] = True
    assert not worker.execution_permitted()
    policy["emergency"] = False
    for field, value in [("desired", "PAUSE"), ("activeDeployment", "different"), ("expiresAt", 0)]:
        old = control[field]
        control[field] = value
        assert not worker.execution_permitted()
        control[field] = old
    lease["leaseOwner"] = "another-worker"
    assert not worker.execution_permitted()


def test_unknown_execution_recovery_never_replays_a_transaction():
    worker = CloudWorker.__new__(CloudWorker)
    worker.pk = "tenant-fixture"
    writes = []
    worker.state = SimpleNamespace(
        query=lambda **_: {
            "Items": [
                {"status": "SUBMITTED", "intentId": "intent-one", "sk": "EXECUTION#intent-one"}
            ]
        },
        update_item=lambda **kw: writes.append(kw),
    )
    with pytest.raises(RuntimeError, match="no blind replay"):
        worker.recover_manifests(SimpleNamespace(get=lambda *_: None))
    assert not writes
    worker.recover_manifests(SimpleNamespace(get=lambda *_: {"state": "RECONCILED"}))
    assert len(writes) == 1
    assert writes[0]["ExpressionAttributeValues"][":s"] == "RECONCILED"


def test_model_review_is_fresh_and_independent_for_each_asset():
    import time

    from backend.data import fixture_market

    worker = CloudWorker.__new__(CloudWorker)
    markets = {s: fixture_market(s) for s in ("BTC", "ETH")}
    worker.engine = SimpleNamespace(markets=markets)
    reviews = {
        s: {
            "symbol": s,
            "marketSource": m.source,
            "marketAsOf": m.as_of.isoformat(),
            "expiresAt": int(time.time()) + 100,
            "veto": s == "ETH",
        }
        for s, m in markets.items()
    }
    worker.control = lambda: {"adviceByAsset": reviews}
    spec = {"execution": {"requireModelReview": True}}
    assert worker.reviewed(spec, "BTC")
    assert not worker.reviewed(spec, "ETH")
    reviews["BTC"]["expiresAt"] = 0
    assert not worker.reviewed(spec, "BTC")
