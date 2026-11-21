"""Bounded activation review for the persisted paper supervisor."""

from decimal import Decimal
from typing import TypedDict

from langgraph.graph import END, START, StateGraph

from backend.paper_execution import PaperTerms


class Activation(TypedDict, total=False):
    report: dict
    terms: PaperTerms
    allow_fixture: bool
    evidence: dict
    reasons: list[str]
    suggestion: str | None


def review_holdout(state: Activation):
    result = state["report"]["result"]
    development, holdout = result["in_sample"], result["out_of_sample"]
    evidence = {
        "development_trades": development["trade_count"],
        "holdout_trades": holdout["trade_count"],
        "holdout_drawdown": holdout["maximum_drawdown"],
        "holdout_return": holdout["total_return"],
        "holdout_benchmark": holdout["benchmark_return"],
    }
    reasons, suggestion = [], None
    if not holdout["trade_count"]:
        reasons.append("Holdout contains no closed trades")
        suggestion = "Review the entry and exit rules on an independent evaluation window."
    return {"evidence": evidence, "reasons": reasons, "suggestion": suggestion}


def activation_risk(state: Activation):
    report, terms = state["report"], state["terms"]
    reasons, suggestion = list(state["reasons"]), state["suggestion"]
    costs = report["result"]["assumptions"]
    if report["result"]["fixture"] and not state["allow_fixture"]:
        reasons.append("Fixture replay")
    if costs["fee_bps"] < terms.fee_bps or costs["slippage_bps"] < terms.slippage_bps:
        reasons.append("Replay understates paper execution costs")
        suggestion = (
            suggestion or "Run a replay using at least the worker's modeled fees and slippage."
        )
    if Decimal(state["evidence"]["holdout_drawdown"]) >= terms.risk.max_drawdown:
        reasons.append("Holdout drawdown exceeds the configured cap")
        suggestion = suggestion or "Evaluate lower position sizing on fresh historical data."
    return {"reasons": reasons, "suggestion": suggestion}


def activation_graph():
    graph = StateGraph(Activation)
    graph.add_node("review_holdout", review_holdout)
    graph.add_node("activation_risk", activation_risk)
    graph.add_edge(START, "review_holdout")
    graph.add_edge("review_holdout", "activation_risk")
    graph.add_edge("activation_risk", END)
    return graph.compile()
