"""Independent paper worker. PostgreSQL is the recurring queue and checkpoint store."""

from __future__ import annotations

import logging
import os
import signal
from decimal import ROUND_DOWN, Decimal
from threading import Event
from typing import TypedDict
from uuid import uuid5

from httpx import HTTPError
from langgraph.graph import END, START, StateGraph

from backend.backtest_repository import get_replay
from backend.historical_data import load_candles
from backend.models import Market, RiskConfig, now
from backend.paper_agents import checkpoint, claim_agent, event, fence
from backend.paper_execution import (
    PX,
    OrderRequest,
    PaperTerms,
    lock_account,
    portfolio,
    positions,
    process_limit,
    submit_order,
)
from backend.paper_market import load_quotes
from backend.platform_db import DSN_ENV, open_database
from backend.strategies import indicators
from backend.strategy_repository import get_strategy
from backend.strategy_rules import StrategyDefinition, rule_signal

log = logging.getLogger(__name__)


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
    def __init__(self, history=load_candles, quotes=load_quotes, *, allow_fixture=False, clock=now):
        self.history, self.quotes = history, quotes
        self.allow_fixture, self.clock = allow_fixture, clock
        self.graph = trade_graph()

    def tick(self, db, work):
        try:
            self._tick(db, work)
        except (ValueError, OSError, HTTPError) as exc:
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
        if work["stage"] == "VALIDATE":
            self._activate(db, work, strategy, terms)
            return

        at = self.clock()
        end = at.replace(minute=0, second=0, microsecond=0)
        market = self.history(definition.asset, end, end)
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
                budget = min(
                    work["capital"] * definition.cash_fraction,
                    account.cash * terms.risk.max_equity_per_trade,
                    terms.risk.max_trade_notional,
                )
                costs = (1 + Decimal(terms.fee_bps) / 10000) * (
                    1 + Decimal(terms.slippage_bps) / 10000
                )
                quantity = (budget / (quote.price * costs)).quantize(PX, rounding=ROUND_DOWN)
            detail = {
                "decision": side,
                "reason": why,
                "regime": str(choice["regime"]),
                "candle_at": candle_at.isoformat(),
                "quote_at": quote.observed_at.isoformat(),
                "source": quote.source,
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

    def _activate(self, db, work, strategy, terms):
        owner, agent = work["owner_id"], work["id"]
        report = get_replay(db, owner, work["report_id"], include_dataset=False)
        if (
            report is None
            or report["strategy_version"] != strategy.version
            or report["strategy_id"] != str(strategy.id)
        ):
            raise ValueError("Replay does not match the pinned strategy")
        holdout = report["result"]["out_of_sample"]
        reasons = []
        if report["result"]["fixture"] and not self.allow_fixture:
            reasons.append("Fixture replay")
        if not holdout["trade_count"]:
            reasons.append("Holdout contains no closed trades")
        if Decimal(holdout["maximum_drawdown"]) >= terms.risk.max_drawdown:
            reasons.append("Holdout drawdown exceeds the configured cap")
        with db.transaction():
            account, stopped = lock_account(db, owner)
            if not fence(db, work) or stopped or account.epoch != work["epoch"]:
                return
            event(
                db,
                owner,
                agent,
                "VALIDATION",
                {
                    "report_id": str(work["report_id"]),
                    "holdout_trades": holdout["trade_count"],
                    "holdout_drawdown": holdout["maximum_drawdown"],
                    "approved": not reasons,
                    "reasons": reasons,
                },
            )
            checkpoint(db, work, status="FAILED" if reasons else "RUNNING", delay=0)


def service(dsn: str, stop: Event, worker: PaperWorker):
    while not stop.is_set():
        try:
            with open_database(dsn) as db:
                db.execute("SET statement_timeout = '5s'")
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
                if not work and not limit:
                    stop.wait(1)
        except Exception as exc:
            log.error("Paper worker operation failed: %s", type(exc).__name__)
            stop.wait(2)


def main():
    logging.basicConfig(level=logging.INFO)
    stop = Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    service(os.environ[DSN_ENV], stop, PaperWorker())


if __name__ == "__main__":
    main()
