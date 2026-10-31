"""Approved Fargate workload. Uses the existing LangGraph, risk engine and simulation ledger.

No public HTTP server, credentials in config, arbitrary code, or live transaction submission.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sqlite3
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from backend.data import Providers
from backend.engine import Engine
from backend.models import Authorize, ResearchEvidence, RiskConfig, RunRequest, StrategyConfig
from backend.selection import SelectionConfig
from backend.storage import Store, encode
from backend.strategies import REGISTRY

ROOT = Path("/app/.runtime")


def control_scalars(value):
    """Restore JS configuration scalars from boto3. Financial amounts stay canonical strings."""
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Non-finite control scalar")
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: control_scalars(v) for k, v in value.items()}
    if isinstance(value, list):
        return [control_scalars(v) for v in value]
    return value


def risk_adapter(r):
    return RiskConfig(
        max_trade_notional=r["maxTradeNotional"],
        max_equity_per_trade=str(r["maxRiskPerTrade"]),
        max_daily_loss=str(r["maxDailyLoss"]),
        max_aggregate_exposure=str(r["maxPortfolioExposure"]),
        max_asset_exposure=str(r["maxAssetExposure"]),
        max_positions=r["maxConcurrentPositions"],
        max_slippage_bps=r["slippageBps"],
        max_price_impact=str(r["maxPriceImpact"]),
        min_liquidity_usd=r["minimumLiquidity"],
        max_network_fee=r["maxNetworkFee"],
        max_drawdown=str(r["maxDrawdown"]),
        cooldown_seconds=r["cooldownSeconds"],
    )


class CloudWorker:
    def __init__(self):
        import boto3
        from botocore.config import Config

        ROOT.mkdir(parents=True, exist_ok=True)
        self.tenant, self.agent, self.deployment = (
            os.environ[k] for k in ("KRONO_TENANT_ID", "KRONO_AGENT_ID", "KRONO_DEPLOYMENT_ID")
        )
        self.pk = f"TENANT#{self.tenant}#AGENT#{self.agent}"
        cfg = Config(
            connect_timeout=3, read_timeout=10, retries={"max_attempts": 2, "mode": "standard"}
        )
        self.db = boto3.resource("dynamodb", config=cfg)
        self.state = self.db.Table(os.environ["KRONO_RUNTIME_TABLE"])
        self.control_table = self.db.Table(os.environ["KRONO_AGENT_CONTROL_TABLE"])
        self.s3, self.sqs = boto3.client("s3", config=cfg), boto3.client("sqs", config=cfg)
        self.stop = False
        self.owner = str(uuid4())
        self.engine = None
        self.acquired = False
        self.last_activity = time.time()
        self.next_run = 0
        self.expires_at = 0
        self.busy = False
        self.observation = {}
        self.seen_review_ids = set()
        self.enqueue_reviews = True

    def control(self):
        return control_scalars(
            self.control_table.get_item(
                Key={"pk": self.pk, "sk": "CONTROL"}, ConsistentRead=True
            ).get("Item", {})
        )

    def event(self, name, data):
        at = datetime.now(timezone.utc).isoformat()
        self.state.put_item(
            Item={
                "pk": self.pk,
                "sk": f"EVENT#{at}#{uuid4()}",
                "at": at,
                "event": name,
                "data": json.loads(encode(data), parse_float=Decimal),
                "deploymentId": self.deployment,
                "expiresAt": int(time.time()) + 30 * 86400,
            }
        )
        print(
            json.dumps({"event": name, "agentId": self.agent, "deploymentId": self.deployment}),
            flush=True,
        )

    def heartbeat(self, status, **extra):
        at = datetime.now(timezone.utc).isoformat()
        for field in ("portfolio", "selectedStrategy", "regime", "lastExecution", "nextRunAt"):
            if field in extra:
                self.observation[field] = extra[field]
        self.state.put_item(
            Item={
                "pk": self.pk,
                "sk": f"HEARTBEAT#{self.deployment}",
                "at": at,
                "status": status,
                "deploymentId": self.deployment,
                "expiresAt": int(time.time()) + 7 * 86400,
                **json.loads(encode({**self.observation, **extra}), parse_float=Decimal),
            }
        )
        (ROOT / "health").write_text(str(time.time()))

    def lease(self):
        from botocore.exceptions import ClientError

        try:
            self.state.update_item(
                Key={"pk": self.pk, "sk": "LEASE"},
                UpdateExpression="SET leaseOwner=:owner, expiresAt=:expiry",
                ConditionExpression="attribute_not_exists(leaseOwner) OR leaseOwner=:owner OR expiresAt < :now",
                ExpressionAttributeValues={
                    ":owner": self.owner,
                    ":expiry": int(time.time()) + 120,
                    ":now": int(time.time()),
                },
            )
            self.acquired = True
            return True
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            return False

    def release(self):
        if self.acquired:
            self.state.update_item(
                Key={"pk": self.pk, "sk": "LEASE"},
                UpdateExpression="SET expiresAt=:zero",
                ConditionExpression="leaseOwner=:owner",
                ExpressionAttributeValues={":zero": 0, ":owner": self.owner},
            )
            self.acquired = False

    def checkpoint(self):
        if not self.engine or not self.acquired:
            return
        target = ROOT / "checkpoint.sqlite3"
        backup = sqlite3.connect(target)
        try:
            with self.engine.store.lock:
                self.engine.store.db.backup(backup)
        finally:
            backup.close()
        object_key = (
            os.environ["KRONO_CHECKPOINT_PREFIX"] + f"checkpoints/{self.owner}/{uuid4()}.sqlite3"
        )
        self.s3.upload_file(
            str(target),
            os.environ["KRONO_ARTIFACT_BUCKET"],
            object_key,
        )
        # A stale worker can upload an orphan object, but cannot replace the durable pointer.
        self.db.meta.client.transact_write_items(
            TransactItems=[
                {
                    "ConditionCheck": {
                        "TableName": os.environ["KRONO_RUNTIME_TABLE"],
                        "Key": {"pk": self.pk, "sk": "LEASE"},
                        "ConditionExpression": "leaseOwner=:owner AND expiresAt>:now",
                        "ExpressionAttributeValues": {
                            ":owner": self.owner,
                            ":now": int(time.time()) + 2,
                        },
                    }
                },
                {
                    "Put": {
                        "TableName": os.environ["KRONO_RUNTIME_TABLE"],
                        "Item": {
                            "pk": self.pk,
                            "sk": "CHECKPOINT",
                            "objectKey": object_key,
                            "at": datetime.now(timezone.utc).isoformat(),
                            "deploymentId": self.deployment,
                        },
                    }
                },
            ]
        )

    async def initialize(self, spec):
        from botocore.exceptions import ClientError

        path = ROOT / "ledger.sqlite3"
        checkpoint = self.state.get_item(
            Key={"pk": self.pk, "sk": "CHECKPOINT"}, ConsistentRead=True
        ).get("Item")
        try:
            if checkpoint and not checkpoint["objectKey"].startswith(
                os.environ["KRONO_CHECKPOINT_PREFIX"]
            ):
                raise RuntimeError("Invalid checkpoint namespace")
            if checkpoint:
                self.s3.download_file(
                    os.environ["KRONO_ARTIFACT_BUCKET"],
                    checkpoint["objectKey"],
                    str(path),
                )
        except ClientError:
            raise RuntimeError("Durable checkpoint unavailable; trading remains disabled") from None
        store = Store(str(path))
        providers = Providers(
            store, spec["configuration"]["marketProvider"], spec["configuration"]["newsProvider"]
        )
        self.engine = Engine(store, providers)
        self.engine.recover()

        def configure(name, value):
            current, _ = store.config(name)
            if current != value:
                store.update_config(name, value)

        configure("risk", risk_adapter(spec["riskPolicy"]).model_dump(mode="json"))
        cfg = spec["configuration"]
        for strategy in REGISTRY:
            configure(
                "strategy:" + strategy,
                StrategyConfig(
                    enabled=strategy in cfg["strategies"]
                    and spec["permissions"]["generateSignals"],
                    assets=[a for a in cfg["assets"] if a in {"BTC", "ETH", "SOL"}] or ["BTC"],
                    **cfg.get("strategyParameters", {}).get(strategy, {}),
                ).model_dump(mode="json"),
            )
        selector = SelectionConfig(
            mode=cfg["selectionMode"],
            minimum_hold_seconds=cfg["minimumStrategyHoldSeconds"],
            switch_cooldown_seconds=cfg["strategySwitchCooldown"],
            **cfg.get("selectionWeights", {}),
        )
        configure("selection", selector.model_dump(mode="json"))
        self.recover_manifests(store)
        await self.engine.refresh_markets()
        if not store.history("snapshots", 1)["items"]:
            self.engine.portfolio.snapshot(self.engine.markets)

    def recover_manifests(self, store):
        cursor = None
        while True:
            page = self.state.query(
                KeyConditionExpression="pk=:pk AND begins_with(sk,:prefix)",
                ExpressionAttributeValues={":pk": self.pk, ":prefix": "EXECUTION#"},
                Limit=100,
                **({"ExclusiveStartKey": cursor} if cursor else {}),
            )
            for intent in page.get("Items", []):
                if intent.get("status") != "SUBMITTED":
                    continue
                local = store.get("intents", intent["intentId"])
                if not local or local["state"] != "RECONCILED":
                    raise RuntimeError("Prior simulation requires reconciliation; no blind replay")
                self.state.update_item(
                    Key={"pk": self.pk, "sk": intent["sk"]},
                    UpdateExpression="SET #s=:s",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={":s": "RECONCILED"},
                )
            cursor = page.get("LastEvaluatedKey")
            if not cursor:
                break

    async def renew_loop(self):
        while not self.stop:
            await asyncio.sleep(15)
            if self.acquired:
                # Losing connectivity expires the lease; final authorization rechecks it.
                self.acquired = await asyncio.to_thread(self.lease)
            if self.busy:
                await asyncio.to_thread(
                    self.heartbeat, "RUNNING", currentTask="Evaluating LangGraph workflow"
                )

    def execution_permitted(self):
        c = self.control()
        policy = self.control_table.get_item(
            Key={"pk": f"TENANT#{self.tenant}#POLICY", "sk": "CONTROL"}, ConsistentRead=True
        ).get("Item", {})
        lease = self.state.get_item(Key={"pk": self.pk, "sk": "LEASE"}, ConsistentRead=True).get(
            "Item", {}
        )
        return (
            c.get("activeDeployment") == self.deployment
            and not policy.get("emergency", False)
            and c.get("desired") == "RUN"
            and int(c.get("expiresAt", 0)) > time.time()
            and lease.get("leaseOwner") == self.owner
            and int(lease.get("expiresAt", 0)) > time.time() + 10
        )

    def request_analysis(self, packet):
        if not self.enqueue_reviews:
            return
        queue = os.environ.get("KRONO_ANALYSIS_QUEUE_URL")
        if not queue:
            return
        request_id = str(uuid4())
        self.state.put_item(
            Item={
                "pk": self.pk,
                "sk": f"ANALYSIS_REQUEST#{request_id}",
                "deploymentId": self.deployment,
                "expiresAt": int(time.time()) + 900,
                "data": json.loads(encode(packet), parse_float=Decimal),
            }
        )
        self.sqs.send_message(
            QueueUrl=queue,
            MessageBody=json.dumps(
                {"tenantId": self.tenant, "agentId": self.agent, "requestId": request_id}
            ),
        )

    def reviewed(self, spec, asset):
        if not spec["execution"].get("requireModelReview", True):
            return True
        advice = self.control().get("adviceByAsset", {}).get(asset, {})
        market = self.engine.markets[asset]
        return (
            advice.get("symbol") == asset
            and advice.get("marketSource") == market.source
            and market.as_of is not None
            and advice.get("marketAsOf") == market.as_of.isoformat()
            and advice.get("expiresAt", 0) > time.time()
            and not advice.get("veto", True)
        )

    def reserve_execution(self, intent, spec, asset):
        at = int(time.time())
        condition = "activeDeployment=:deployment AND desired=:run AND expiresAt>:now AND activeSpec.permissions.executeTrades=:yes AND activeSpec.execution.automaticSimulationFills=:yes"
        values = {":deployment": self.deployment, ":run": "RUN", ":now": at, ":yes": True}
        if spec["execution"].get("requireModelReview", True):
            condition += " AND adviceByAsset.#asset.veto=:no AND adviceByAsset.#asset.expiresAt>:now AND adviceByAsset.#asset.symbol=:symbol AND adviceByAsset.#asset.marketAsOf=:asof AND adviceByAsset.#asset.marketSource=:source"
            market = self.engine.markets[asset]
            values.update(
                {
                    ":no": False,
                    ":symbol": asset,
                    ":asof": market.as_of.isoformat(),
                    ":source": market.source,
                }
            )
        self.db.meta.client.transact_write_items(
            TransactItems=[
                {
                    "ConditionCheck": {
                        "TableName": os.environ["KRONO_AGENT_CONTROL_TABLE"],
                        "Key": {"pk": f"TENANT#{self.tenant}#POLICY", "sk": "CONTROL"},
                        "ConditionExpression": "attribute_not_exists(emergency) OR emergency=:no",
                        "ExpressionAttributeValues": {":no": False},
                    }
                },
                {
                    "ConditionCheck": {
                        "TableName": os.environ["KRONO_AGENT_CONTROL_TABLE"],
                        "Key": {"pk": self.pk, "sk": "CONTROL"},
                        "ConditionExpression": condition,
                        "ExpressionAttributeValues": values,
                        **(
                            {"ExpressionAttributeNames": {"#asset": asset}}
                            if spec["execution"].get("requireModelReview", True)
                            else {}
                        ),
                    }
                },
                {
                    "ConditionCheck": {
                        "TableName": os.environ["KRONO_RUNTIME_TABLE"],
                        "Key": {"pk": self.pk, "sk": "LEASE"},
                        "ConditionExpression": "leaseOwner=:owner AND expiresAt>:now",
                        "ExpressionAttributeValues": {":owner": self.owner, ":now": at + 10},
                    }
                },
                {
                    "Put": {
                        "TableName": os.environ["KRONO_RUNTIME_TABLE"],
                        "Item": {
                            "pk": self.pk,
                            "sk": f"EXECUTION#{intent['id']}",
                            "intentId": intent["id"],
                            "status": "SUBMITTED",
                            "mode": "SIMULATION",
                            "deploymentId": self.deployment,
                            "at": datetime.now(timezone.utc).isoformat(),
                        },
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
            ]
        )

    async def run_once(self, spec, *, request_review=True, assets=None):
        self.enqueue_reviews = request_review
        cfg = spec["configuration"]
        if spec["type"] == "news_monitor":
            feed = await self.engine.providers.news()
            relevant = [
                a.model_dump(mode="json")
                for a in feed.articles
                if set(a.assets) & set(cfg["assets"])
            ]
            self.event(
                "news.observed",
                {
                    "source": feed.source,
                    "status": feed.status,
                    "retrievedAt": feed.retrieved_at,
                    "articles": relevant[:20],
                },
            )
            self.request_analysis(
                {
                    "symbol": cfg["assets"][0],
                    "marketSource": None,
                    "marketAsOf": None,
                    "rankings": [],
                    "evidenceRefs": [a["id"] for a in relevant],
                    "news": relevant[:12],
                    "limitations": [
                        "News monitoring only; no market or on-chain evidence is implied"
                    ],
                }
            )
            self.last_activity = time.time() if relevant else self.last_activity
            return
        if not spec["permissions"]["generateSignals"]:
            markets = await self.engine.refresh_markets()
            self.event(
                "markets.observed",
                {
                    "markets": [
                        {
                            "asset": m.asset.symbol,
                            "price": m.price,
                            "source": m.source,
                            "asOf": m.price_at,
                            "status": m.status,
                        }
                        for m in markets
                        if m.asset.symbol in cfg["assets"]
                    ]
                },
            )
            return
        # Coordinated opportunities are untrusted evidence, not orders or sizing instructions.
        inbox = []
        cursor = None
        for _ in range(5):
            page = self.state.query(
                KeyConditionExpression="pk=:pk AND begins_with(sk,:prefix)",
                FilterExpression="expiresAt>:now",
                ExpressionAttributeValues={
                    ":pk": self.pk,
                    ":prefix": "INBOX#",
                    ":now": int(time.time()),
                },
                Limit=100,
                **({"ExclusiveStartKey": cursor} if cursor else {}),
            )
            inbox.extend(page.get("Items", []))
            cursor = page.get("LastEvaluatedKey")
            if not cursor or len(inbox) >= 10:
                break
        coordinated = []
        for opportunity in inbox:
            if int(opportunity.get("expiresAt", 0)) > time.time():
                try:
                    data = opportunity["opportunity"]
                    coordinated.append(
                        ResearchEvidence(
                            opportunity_id=opportunity["sk"].split("#", 1)[1],
                            source_agent_id=opportunity["sourceAgentId"],
                            symbol=data["asset"],
                            signal=data["signal"],
                            evidence=[
                                ref
                                for s in data.get("evidence", [])
                                for ref in s.get("evidence", [])
                            ][:30],
                        ).model_dump(mode="json")
                    )
                except (ValueError, KeyError, TypeError):
                    self.event(
                        "research.invalid",
                        {"reason": "Invalid coordinated research record; ignored"},
                    )
                    continue
                self.event(
                    "research.evaluated",
                    {
                        "sourceAgentId": opportunity["sourceAgentId"],
                        "opportunity": opportunity["opportunity"],
                        "policy": "Independent market, strategy, risk and quote validation still required",
                    },
                )
        for asset in assets or cfg["assets"]:
            if not self.execution_permitted():
                return
            run = await asyncio.wait_for(
                self.engine.run(
                    RunRequest(symbol=asset, notional=spec["riskPolicy"]["maxTradeNotional"]),
                    external_evidence=[e for e in coordinated if e["symbol"] == asset],
                ),
                timeout=90,
            )
            selection = run.get("selection", {})
            self.event("agent.evaluated", run)
            feed = await self.engine.providers.news()
            articles = [a.model_dump(mode="json") for a in feed.articles if asset in a.assets][:12]
            self.request_analysis(
                {
                    "symbol": asset,
                    "marketSource": self.engine.markets[asset].source,
                    "marketAsOf": self.engine.markets[asset].as_of.isoformat()
                    if self.engine.markets[asset].as_of
                    else None,
                    "features": selection.get("features", {}),
                    "rankings": selection.get("rankings", []),
                    "signals": run.get("signals", []),
                    "coordinatedResearch": run.get("research_evidence", []),
                    "evidenceRefs": list(
                        {e for s in run.get("signals", []) for e in s["evidence"]}
                        | {a["id"] for a in articles}
                        | {
                            "opportunity:" + e["opportunity_id"]
                            for e in run.get("research_evidence", [])
                        }
                    ),
                    "news": articles,
                }
            )
            intent = run.get("intent")
            allowed = (
                spec["type"] == "trading"
                and spec["permissions"]["executeTrades"]
                and spec["execution"]["automaticSimulationFills"]
            )
            if (
                allowed
                and intent
                and intent["state"] == "AWAITING_AUTHORIZATION"
                and self.execution_permitted()
                and self.reviewed(spec, asset)
            ):
                # Persist preview before fill. A timeout never submits again without reloading the intent ledger.
                self.checkpoint()
                self.reserve_execution(intent, spec, asset)
                result = await self.engine.authorize(
                    Authorize(
                        intent_id=intent["id"],
                        quote_id=intent["quote"]["id"],
                        acknowledgement="AUTHORIZE_SIMULATION",
                    )
                )
                self.checkpoint()
                self.state.update_item(
                    Key={"pk": self.pk, "sk": f"EXECUTION#{intent['id']}"},
                    UpdateExpression="SET #s=:s",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={":s": "RECONCILED"},
                )
                self.event("execution.simulated", result)
                self.last_activity = time.time()
            if (
                spec["coordination"]["publishOpportunities"]
                and spec["type"] != "trading"
                and run.get("decision") in {"BUY", "SELL"}
            ):
                oid = str(uuid4())
                self.state.put_item(
                    Item={
                        "pk": self.pk,
                        "sk": f"OPPORTUNITY#{oid}",
                        "deploymentId": self.deployment,
                        "expiresAt": int(time.time()) + 300,
                        "data": {
                            "asset": asset,
                            "signal": run["decision"],
                            "runId": run["id"],
                            "evidence": run.get("signals", []),
                        },
                    }
                )
                self.sqs.send_message(
                    QueueUrl=os.environ["KRONO_COORDINATION_QUEUE_URL"],
                    MessageBody=json.dumps(
                        {"tenantId": self.tenant, "sourceAgentId": self.agent, "opportunityId": oid}
                    ),
                )
            self.heartbeat(
                "RUNNING",
                currentTask="Monitoring",
                selectedStrategy=next(iter(selection.get("selected", [])), None),
                regime=selection.get("regime"),
                lastExecution=run["ended_at"],
                nextRunAt=datetime.fromtimestamp(
                    time.time() + cfg["monitoringInterval"], timezone.utc
                ).isoformat(),
                portfolio=self.engine.portfolio.view(self.engine.markets),
            )

    async def run(self):
        renew = asyncio.create_task(self.renew_loop())
        try:
            while not self.stop:
                if renew.done():
                    renew.result()
                c = await asyncio.to_thread(self.control)
                if c.get("activeDeployment") != self.deployment:
                    if self.engine and c.get("candidateDeployment") != self.deployment:
                        self.checkpoint()
                        self.release()
                        self.heartbeat("STOPPED", currentTask="Replaced by a healthy deployment")
                        break
                    self.heartbeat("READY", currentTask="Awaiting verified activation")
                    if self.acquired:
                        self.checkpoint()
                        self.release()
                    await asyncio.sleep(5)
                    continue
                spec = c["activeSpec"]
                if (
                    time.time() >= int(c.get("expiresAt", 0))
                    or time.time() - self.last_activity > spec["execution"]["idleShutdownSeconds"]
                    or c.get("desired") == "STOP"
                ):
                    self.checkpoint()
                    self.release()
                    self.heartbeat(
                        "STOPPED",
                        currentTask="Budget/idle/stop policy reached; awaiting service scale-down",
                    )
                    break
                if c.get("desired") == "PAUSE":
                    self.checkpoint()
                    self.release()
                    self.heartbeat(
                        "PAUSED",
                        currentTask="New entries and evaluation paused; inventory retained",
                    )
                    await asyncio.sleep(5)
                    continue
                if not self.acquired and not await asyncio.to_thread(self.lease):
                    self.heartbeat("READY", currentTask="Waiting for prior runtime lease")
                    await asyncio.sleep(5)
                    continue
                if self.engine is None:
                    await self.initialize(spec)
                advice = c.get("adviceByAsset", {})
                if self.engine.store.config("model_reviews")[0] != advice:
                    self.engine.store.update_config("model_reviews", advice)
                scheduled = time.time() >= self.next_run
                fresh_reviews = [
                    asset
                    for asset, review in advice.items()
                    if asset in spec["configuration"]["assets"]
                    and review.get("requestId")
                    and review["requestId"] not in self.seen_review_ids
                    and review.get("expiresAt", 0) > time.time()
                ]
                continuation = (
                    spec["type"] == "trading"
                    and spec["execution"]["automaticSimulationFills"]
                    and bool(fresh_reviews)
                )
                if scheduled or continuation:
                    self.busy = True
                    try:
                        await self.run_once(
                            spec,
                            request_review=scheduled,
                            assets=None if scheduled else fresh_reviews,
                        )
                    finally:
                        self.busy = False
                    if scheduled:
                        self.next_run = time.time() + spec["configuration"]["monitoringInterval"]
                    self.seen_review_ids.update(
                        review["requestId"] for review in advice.values() if review.get("requestId")
                    )
                    await asyncio.to_thread(self.checkpoint)
                self.heartbeat(
                    "RUNNING",
                    currentTask="Monitoring",
                    nextRunAt=datetime.fromtimestamp(self.next_run, timezone.utc).isoformat(),
                    portfolio=self.engine.portfolio.view(self.engine.markets),
                )
                await asyncio.sleep(5)
        except Exception as exc:
            self.heartbeat("FAILED", errorType=type(exc).__name__)
            self.event("runtime.failed", {"errorType": type(exc).__name__})
            raise
        finally:
            self.stop = True
            renew.cancel()
            await asyncio.gather(renew, return_exceptions=True)
            if self.engine:
                self.checkpoint()
                await self.engine.close()
                self.engine.store.close()
            self.release()


def main():
    if "--health" in sys.argv:
        try:
            healthy = time.time() - float((ROOT / "health").read_text()) < 60
        except (OSError, ValueError):
            healthy = False
        raise SystemExit(0 if healthy else 1)
    worker = CloudWorker()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: setattr(worker, "stop", True))
    asyncio.run(worker.run())


if __name__ == "__main__":
    main()
