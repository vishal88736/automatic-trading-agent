"""Independent paper worker. PostgreSQL is the recurring queue and checkpoint store."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import time
from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, Decimal
from threading import Event
from typing import TypedDict
from uuid import uuid5

from langgraph.graph import END, START, StateGraph

from backend.models import Market, RiskConfig, now
from backend.product.agents import checkpoint, claim_agent, event, fence, mark_agent
from backend.product.backtests import get_replay, save_replay
from backend.product.database import DSN_ENV, open_database
from backend.product.execution import (
    PX,
    OrderRequest,
    PaperTerms,
    lock_account,
    portfolio,
    positions,
    process_limit,
    submit_order,
)
from backend.product.history import HistoricalBacktestRequest, load_candles
from backend.product.market import load_quotes
from backend.product.rules import StrategyDefinition, rule_signal, spot_entry_budget
from backend.product.strategies import get_strategy
from backend.product.workflow import activation_graph
from backend.strategies import indicators

log = logging.getLogger(__name__)
REVIEW_INTERVAL = timedelta(days=7)


class Tick(TypedDict, total=False):
    definition: StrategyDefinition
    market: Market
    holding: bool
    signal: str
    regime: str


def research(state: Tick):
    return {"regime": indicators(state["market"])["regime"]}


def rules(state: Tick):
    return {"signal": rule_signal(state["definition"], state["market"], holding=state["holding"])}


def trade_graph():
    graph = StateGraph(Tick)
    graph.add_node("research", research)
    graph.add_node("rules", rules)
    graph.add_edge(START, "research")
    graph.add_edge("research", "rules")
    graph.add_edge("rules", END)
    return graph.compile()


class PaperWorker:
    def __init__(
        self,
        history=load_candles,
        quotes=load_quotes,
        *,
        allow_fixture=False,
        clock=now,
        market_clock=None,
    ):
        self.history, self.quotes = history, quotes
        self.allow_fixture, self.clock = allow_fixture, clock
        self.market_clock = market_clock or clock
        self.graph = trade_graph()
        self.activation = activation_graph()
        self.closed_markets = {}

    def tick(self, db, work):
        try:
            self._tick(db, work)
        except Exception as exc:
            self._fail(db, work, type(exc).__name__)

    def _fail(self, db, work, reason):
        owner, agent = work["owner_id"], work["id"]
        with db.transaction():
            lock_account(db, owner)
            if fence(db, work):
                failures = work["failures"] + 1
                event(
                    db,
                    owner,
                    agent,
                    "RETRY" if failures < 5 else "FAILED",
                    {"stage": work["stage"], "error": reason, "attempt": failures},
                )
                checkpoint(
                    db,
                    work,
                    stage=work["stage"],
                    status="RUNNING" if failures < 5 else "FAILED",
                    failures=failures,
                    delay=min(300, 30 * 2 ** (failures - 1)),
                    peak=work["peak_price"],
                )

    def _tick(self, db, work):
        owner, agent = work["owner_id"], work["id"]
        strategy = get_strategy(db, owner, work["strategy_id"], work["strategy_version"])
        if strategy is None:
            raise ValueError("The pinned strategy is unavailable")
        definition = strategy.document.definition
        terms = PaperTerms(
            risk=RiskConfig(
                max_drawdown=work["max_drawdown"], max_daily_loss=work["max_daily_loss"]
            )
        )
        revalidation = (
            work["stage"] == "MONITOR"
            and work["next_review_at"] is not None
            and self.clock() >= work["next_review_at"]
        )
        if work["stage"] == "VALIDATE" or revalidation:
            self._validate(db, work, strategy, terms, revalidation=revalidation)
            return

        end = self.market_clock().replace(minute=0, second=0, microsecond=0)
        market = self.closed_markets.get(definition.asset)
        if market is None or market.as_of != end:
            market = self.history(definition.asset, end, end)
            if market.status in {"AVAILABLE", "FIXTURE"} and market.as_of == end:
                self.closed_markets[definition.asset] = market
        if market.status == "FIXTURE" and not self.allow_fixture:
            raise ValueError("Fixture data cannot drive this worker")
        if not market.candles or market.candles[-1].closed_at != end:
            raise ValueError("Latest closed candle is unavailable")
        quotes = self.quotes({definition.asset} | set(positions(db, owner, work["epoch"])))
        quote = quotes.get(definition.asset)
        if (
            not quote
            or quote.asset != definition.asset
            or (quote.source == "fixture" and not self.allow_fixture)
        ):
            raise ValueError("Paper quote is unavailable")
        with db.transaction():
            account, stopped = lock_account(db, owner)
            if not fence(db, work) or stopped or account.epoch != work["epoch"]:
                return
            now_at = self.clock()
            age = (now_at - quote.observed_at).total_seconds()
            if not 0 <= age <= terms.risk.max_quote_age_seconds:
                raise ValueError("Paper quote is stale")
            if work["last_quote"] is not None and quote.observed_at < work["last_quote"]:
                raise ValueError("Paper quote moved backwards")
            position = positions(db, owner, account.epoch, actor_only=True, agent_id=agent).get(
                definition.asset
            )
            quantity = position["quantity"] if position else Decimal(0)
            candle_at = market.candles[-1].closed_at
            new_candle = work["last_candle"] is None or candle_at > work["last_candle"]
            peak = max(work["peak_price"] or quote.price, quote.price) if quantity else None
            equity, breach = mark_agent(db, work, quantity, quote.price, now_at)
            if breach:
                event(db, owner, agent, "RISK_PAUSED", {"reason": breach, "equity": str(equity)})
                checkpoint(
                    db, work, status="PAUSED", candle=candle_at, quote=quote.observed_at, peak=peak
                )
                return
            choice = self.graph.invoke(
                {"definition": definition, "market": market, "holding": quantity > 0}
            )
            side, why = (
                (choice["signal"], "Strategy rule")
                if new_candle
                else ("HOLD", "No new closed candle")
            )
            if quantity:
                fill_price = db.execute(
                    """
                    SELECT l.price FROM paper_orders o JOIN paper_ledger_entries l ON o.id = l.order_id
                    WHERE o.owner_id = %s AND o.agent_id = %s AND l.kind = 'BUY'
                    ORDER BY l.id DESC LIMIT 1
                    """,
                    (owner, agent),
                ).fetchone()[0]
                if quote.price <= fill_price * (1 - definition.stop_loss):
                    side, why = "SELL", "Stop loss"
                elif definition.trailing_stop and quote.price <= peak * (
                    1 - definition.trailing_stop
                ):
                    side, why = "SELL", "Trailing stop"
                elif definition.take_profit and quote.price >= fill_price * (
                    1 + definition.take_profit
                ):
                    side, why = "SELL", "Take profit"
            if side == "BUY":
                # Use the agent's remaining virtual cash, within the allocation limit.
                cash_available = max(
                    Decimal(0), min(work["capital"], equity - quantity * quote.price)
                )
                budget = min(
                    spot_entry_budget(cash_available, equity, definition, terms.risk),
                    account.cash * terms.risk.max_equity_per_trade,
                    terms.risk.max_trade_notional,
                )
                costs = (1 + Decimal(terms.fee_bps) / 10000) * (
                    1 + Decimal(terms.slippage_bps) / 10000
                )
                quantity = (
                    (budget / (quote.price * costs)).quantize(PX, rounding=ROUND_DOWN)
                    if budget >= 1
                    else Decimal(0)
                )
            detail = {
                "decision": side,
                "reason": why,
                "regime": str(choice["regime"]),
                "candle_at": candle_at.isoformat(),
                "quote_at": quote.observed_at.isoformat(),
                "source": quote.source,
                "price": str(quote.price),
            }
            if side in ("BUY", "SELL") and quantity > 0:
                order = submit_order(
                    db,
                    owner,
                    OrderRequest(
                        request_key=uuid5(
                            agent, f"{candle_at.isoformat()}|{quote.observed_at.isoformat()}|{side}"
                        ),
                        epoch=account.epoch,
                        asset=definition.asset,
                        side=side,
                        quantity=quantity,
                    ),
                    quotes,
                    terms,
                    agent_id=agent,
                    clock=lambda: now_at,
                )
                detail.update(
                    order_id=str(order["id"]),
                    order_status=order["status"],
                    order_reason=order["reason"],
                )
                if order["status"] == "FILLED":
                    peak = quote.price if side == "BUY" else None
            if new_candle or quote.observed_at != work["last_quote"]:
                event(db, owner, agent, "DECISION", detail)
            portfolio(db, owner, quotes, clock=lambda: now_at)
            checkpoint(db, work, candle=candle_at, quote=quote.observed_at, peak=peak)

    def _validate(self, db, work, strategy, terms, *, revalidation):
        owner, agent = work["owner_id"], work["id"]
        report = None
        if work["report_id"] is not None:
            report = get_replay(db, owner, work["report_id"], include_dataset=False)
            if (
                report is None
                or report["strategy_version"] != strategy.version
                or report["strategy_id"] != str(strategy.id)
            ):
                raise ValueError("Replay does not match the pinned strategy")

        study = None
        if report is None or revalidation:
            end = self.clock().astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
            start = end - REVIEW_INTERVAL
            if report and start < datetime.fromisoformat(report["request"]["end"]):
                raise ValueError("Independent re-evaluation window is unavailable")
            study = HistoricalBacktestRequest(
                version=strategy.version,
                start=start,
                end=end,
                initial_equity=work["capital"],
                fee_bps=terms.fee_bps,
                slippage_bps=terms.slippage_bps,
                risk=terms.risk,
            )
            market = self.history(strategy.document.definition.asset, start, end)

        with db.transaction():
            account, stopped = lock_account(db, owner)
            if not fence(db, work) or stopped or account.epoch != work["epoch"]:
                return
            if study is not None:
                report = save_replay(db, owner, strategy, study, market)
            review = self.activation.invoke(
                {"report": report, "terms": terms, "allow_fixture": self.allow_fixture}
            )
            reasons = review["reasons"]
            event(
                db,
                owner,
                agent,
                "REVALIDATION" if revalidation else "VALIDATION",
                {
                    "report_id": report["id"],
                    **review["evidence"],
                    "approved": not reasons,
                    "reasons": reasons,
                    "suggestion": review["suggestion"],
                },
            )
            db.execute(
                "UPDATE paper_agents SET report_id = %s, next_review_at = %s WHERE id = %s",
                (report["id"], self.clock() + REVIEW_INTERVAL, agent),
            )
            checkpoint(
                db,
                work,
                stage=work["stage"] if reasons else "MONITOR",
                status="FAILED" if reasons else "RUNNING",
                delay=0,
                peak=work["peak_price"],
            )


def heartbeat_fresh(db, worker_id=None):
    return db.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM paper_worker_heartbeats
            WHERE (%s::text IS NULL OR worker_id = %s)
                AND seen_at > clock_timestamp() - interval '30 seconds'
        )
        """,
        (worker_id, worker_id),
    ).fetchone()[0]


def worker_identity():
    return os.environ.get("KRONO_PAPER_WORKER_ID", socket.gethostname())


def service(dsn: str, stop: Event, worker: PaperWorker):
    from backend.product.credentials import CredentialVault
    from backend.product.live import default_client, mirror_fills

    vault = CredentialVault.from_environment()
    worker_id = worker_identity()
    last_heartbeat = float("-inf")
    while not stop.is_set():
        try:
            with open_database(dsn) as db:
                db.execute("SET statement_timeout = '5s'")
                if time.monotonic() - last_heartbeat >= 5:
                    db.execute(
                        """
                        INSERT INTO paper_worker_heartbeats VALUES (%s, clock_timestamp())
                        ON CONFLICT (worker_id) DO UPDATE SET seen_at = excluded.seen_at
                        """,
                        (worker_id,),
                    )
                    last_heartbeat = time.monotonic()
                work = claim_agent(db)
                if work:
                    worker.tick(db, work)
                limit = db.execute(
                    """
                    WITH due AS (
                        SELECT id FROM paper_orders WHERE status = 'OPEN' AND next_check <= now()
                        ORDER BY next_check FOR UPDATE SKIP LOCKED LIMIT 1
                    )
                    UPDATE paper_orders o SET next_check = now() + interval '15 seconds'
                    FROM due WHERE due.id = o.id RETURNING o.id, o.owner_id, o.epoch, o.request->>'asset'
                    """
                ).fetchone()
                if limit:
                    ident, owner, epoch, asset = limit
                    quotes = worker.quotes({asset} | set(positions(db, owner, epoch)))
                    process_limit(db, owner, ident, quotes, PaperTerms())
                # Promoted agents: copy new paper fills to their linked exchange accounts.
                mirrored = mirror_fills(db, vault, default_client) if vault else 0
                if not work and not limit and not mirrored:
                    stop.wait(1)
        except Exception as exc:
            log.error("Paper worker operation failed: %s", type(exc).__name__)
            stop.wait(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--health", action="store_true", help="Check this worker's database heartbeat"
    )
    args = parser.parse_args()
    if args.health:
        with open_database(os.environ[DSN_ENV]) as db:
            raise SystemExit(0 if heartbeat_fresh(db, worker_identity()) else 1)
    logging.basicConfig(level=logging.INFO)
    stop = Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    service(os.environ[DSN_ENV], stop, PaperWorker())


if __name__ == "__main__":
    main()
