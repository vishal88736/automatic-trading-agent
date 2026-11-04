"""Named website controls shared by model tools and the command router.

No arbitrary URL, browser script, raw transaction or filesystem operation is accepted.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Literal

from pydantic import Field

from aegis.data import StrictModel
from aegis.history import TradeFilters

Strategy = Literal[
    "momentum_v1", "mean_reversion_v1", "trend_following_v1", "breakout_v1", "spread_research_v1"
]
Page = Literal[
    "overview",
    "desk",
    "markets",
    "news",
    "strategies",
    "positions",
    "executions",
    "observatory",
    "risk",
    "wallet",
    "settings",
    "sessions",
]


class Empty(StrictModel):
    pass


class Asset(StrictModel):
    asset: Literal["WHSK", "WETH", "WBTC"] = "WHSK"


class Toggle(StrictModel):
    strategy_id: Strategy
    enabled: bool


class Backtest(StrictModel):
    symbol: Literal["BTC", "ETH", "SOL"] = "BTC"
    strategy_id: Literal[
        "momentum_v1", "mean_reversion_v1", "trend_following_v1", "breakout_v1"
    ] = "momentum_v1"


class Alert(StrictModel):
    symbol: Literal["BTC", "ETH", "SOL"]
    condition: Literal["ABOVE", "BELOW"]
    price: Decimal = Field(gt=0, le=1000000000000, max_digits=38, decimal_places=18)


class AlertId(StrictModel):
    alert_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")


class Navigation(StrictModel):
    workspace: Literal["aegis", "research", "platform"] = "aegis"
    page: Page = "overview"


class Wallet(StrictModel):
    action: Literal["deposit", "withdraw", "pause", "resume"] = "deposit"
    network: Literal["testnet", "mainnet"] = "testnet"
    amount: Decimal | None = Field(
        default=None, gt=0, le=1000000000000, max_digits=38, decimal_places=18
    )


class ResearchAsset(StrictModel):
    symbol: Literal["BTC", "ETH", "SOL"] = "BTC"


class History(TradeFilters):
    workspace: Literal["aegis", "research"] = "aegis"


SCHEMAS = {
    "get_website_capabilities": (
        Empty,
        "List available website controls and actions requiring human review",
    ),
    "refresh_market_data": (Empty, "Refresh verified HSKSwap data without placing an order"),
    "inspect_routes": (
        Asset,
        "Read fresh executable HSKSwap routes for one asset; creates no order",
    ),
    "get_library_strategies": (
        Empty,
        "Read actual strategy configurations, versions and enable states",
    ),
    "set_library_strategy_enabled": (
        Toggle,
        "Enable or disable a research library engine using the website's validated versioned settings",
    ),
    "run_backtest": (
        Backtest,
        "Run the website's measured historical research backtest, not a live trade",
    ),
    "get_alerts": (Empty, "Read saved research price alerts"),
    "create_alert": (Alert, "Create a validated research price alert"),
    "delete_alert": (AlertId, "Delete a saved price alert by its exact recorded identifier"),
    "get_trade_history": (
        History,
        "Read the named workspace's trade archive using validated filters and pagination",
    ),
    "export_trade_history": (
        History,
        "Download a page of the named workspace's trade archive as JSON; includes total and pagination",
    ),
    "open_workspace": (Navigation, "Open a named website workspace/page; never an arbitrary URL"),
    "prepare_wallet_action": (
        Wallet,
        "Open and prefill an owner wallet review. Never signs, submits, connects a wallet or changes execution mode",
    ),
    "request_emergency_clear": (
        Empty,
        "Open a human emergency-stop review; cannot clear the stop itself",
    ),
    "get_news": (ResearchAsset, "Read available news for a reference asset with source provenance"),
    "analyze_market": (
        ResearchAsset,
        "Run the website's research analysis for a reference asset; does not authorize a fill",
    ),
}
BRIDGED = {
    "get_library_strategies",
    "set_library_strategy_enabled",
    "run_backtest",
    "get_alerts",
    "create_alert",
    "delete_alert",
    "get_news",
    "analyze_market",
}
ARCHIVES = {"get_trade_history", "export_trade_history"}


def archive_result(name: str, workspace: str, data: dict) -> dict:
    result = {
        **data,
        "workspace": workspace,
        "summary": f"Showing {len(data['items'])} of {data['total']} matching {workspace} trades, offset {data['offset']}.",
    }
    if name == "export_trade_history":
        result["ui_action"] = {
            "type": "download",
            "filename": f"{workspace}-trade-history.json",
            "data": data,
        }
    return result


def definitions():
    return [
        {"name": name, "description": description, "input_schema": model.model_json_schema()}
        for name, (model, description) in SCHEMAS.items()
    ]


def execute(runtime, name: str, arguments: dict) -> dict:
    model, _ = SCHEMAS[name]
    args = model.model_validate(arguments).model_dump(mode="json")
    if name in BRIDGED:
        bridge = getattr(runtime, "terminal_bridge", None)
        if bridge is None:
            raise ValueError("Website controls are unavailable in this runtime")
        return bridge(name, args)
    if name == "get_website_capabilities":
        return {
            "website_tools": list(SCHEMAS),
            "summary": "I can refresh pools, inspect routes, read positions, P&L and sessions, change trading preferences, pause/start the agent, trigger PANIC, toggle library engines, run backtests, manage price alerts, read/export trade history, read news, analyze markets and open website pages. Manual trades, emergency clearance and wallet operations require your review. Cloud agents use their signed-in platform assistant. I cannot change execution mode, wallet keys, Guard caps or model/environment settings.",
        }
    if name == "refresh_market_data":
        state = runtime.observe()
        if state.get("last_error") or not state.get("valuation_fresh"):
            raise ValueError(state.get("last_error") or "Fresh market data is unavailable")
        return {
            "block_number": state["block_number"],
            "pool_activity": state["pool_activity"],
            "summary": f"Verified pool data refreshed at block {state['block_number']}. This refresh placed no order.",
        }
    if name == "inspect_routes":
        data = runtime.market_details(args["asset"])
        return {
            **data,
            "summary": f"{len(data['routes'])} executable route quote(s) returned for {args['asset']}. No order was placed.",
        }
    if name in ARCHIVES:
        workspace = args.pop("workspace")
        if workspace == "research":
            bridge = getattr(runtime, "terminal_bridge", None)
            if bridge is None:
                raise ValueError("Research trade history is unavailable in this runtime")
            return bridge(name, {**args, "workspace": workspace})
        return archive_result(name, workspace, runtime.trade_history(args))
    if name == "open_workspace":
        if args["workspace"] == "aegis" and args["page"] == "news":
            raise ValueError("News is in the research workspace; choose workspace research")
        return {
            "ui_action": {"type": "navigate", **args},
            "summary": f"Opening {args['workspace']} / {args['page']}.",
        }
    if name == "prepare_wallet_action":
        if args["amount"] is not None:
            args["amount"] = format(Decimal(args["amount"]), "f")
        return {
            "ui_action": {"type": "wallet_review", **args},
            "summary": f"Opening the {args['network']} owner wallet page for {args['action']}. Review the amount and transaction there; nothing was signed or submitted. This does not switch the agent's execution mode.",
        }
    if not runtime.view()["emergency"]:
        return {"summary": "No emergency stop is latched. Nothing changed."}
    return {
        "kind": "emergency_clear",
        "requires_confirmation": True,
        "mode": runtime.mode,
        "summary": "Review the emergency stop before clearing it. The backend still requires fresh marks and no open positions; entries remain paused after clearance.",
    }


STRATEGIES = {
    "momentum": "momentum_v1",
    "mean reversion": "mean_reversion_v1",
    "trend following": "trend_following_v1",
    "breakout": "breakout_v1",
    "spread research": "spread_research_v1",
}


def command(text: str) -> tuple[str, dict] | None:
    t = text.lower().strip().rstrip(".!?")
    match = re.fullmatch(r"(?:open|go to) (aegis|research|platform)(?: workspace)?", t)
    if match:
        return "open_workspace", {"workspace": match[1], "page": "overview"}
    if re.fullmatch(
        r"(?:what can you (?:do|control)|(?:show|list) (?:your )?(?:controls|capabilities)|help with controls)",
        t,
    ):
        return "get_website_capabilities", {}
    if re.fullmatch(
        r"(?:please )?(?:refresh|check|update)(?: the)? (?:live )?(?:pool(?:s| data)?|market data|hskswap(?: data)?)(?: now)?",
        t,
    ):
        return "refresh_market_data", {}
    if re.fullmatch(r"(?:review and )?clear (?:the )?(?:emergency stop|stop|panic)", t):
        return "request_emergency_clear", {}
    if re.fullmatch(r"(?:show|list) (?:my |the )?(?:library )?strategies", t):
        return "get_library_strategies", {}
    match = re.fullmatch(r"(?:please )?(enable|disable) (.+?)(?: strategy| engine)?", t)
    if match and match[2] in STRATEGIES:
        return "set_library_strategy_enabled", {
            "strategy_id": STRATEGIES[match[2]],
            "enabled": match[1] == "enable",
        }
    match = re.fullmatch(
        r"(?:run )?(?:a )?backtest(?: for)? (momentum|mean reversion|trend following|breakout)(?: (?:on|for) (btc|eth|sol))?",
        t,
    )
    if match:
        return "run_backtest", {
            "strategy_id": STRATEGIES[match[1]],
            "symbol": (match[2] or "btc").upper(),
        }
    if re.fullmatch(r"(?:show|list) (?:my |price )?alerts", t):
        return "get_alerts", {}
    match = re.fullmatch(
        r"(?:create|add|set) (?:(?:a|an) )?(btc|eth|sol)(?: price)? alert (above|below) (\d+(?:\.\d+)?)",
        t,
    )
    if match:
        return "create_alert", {
            "symbol": match[1].upper(),
            "condition": match[2].upper(),
            "price": match[3],
        }
    match = re.fullmatch(r"(?:delete|remove) alert ([a-z0-9_-]+)", t)
    if match:
        return "delete_alert", {"alert_id": match[1]}
    if re.fullmatch(
        r"(?:show|list|read)(?: my)? (?:past trades|trade history|execution history)", t
    ):
        return "get_trade_history", {}
    if re.fullmatch(r"(?:export|download)(?: my)? (?:trade|execution) history", t):
        return "export_trade_history", {}
    match = re.fullmatch(
        r"(?:inspect|show|compare)(?: executable)? routes?(?: for)? (whsk|hsk|weth|eth|wbtc|btc)", t
    )
    if match:
        asset = match[1].upper()
        return "inspect_routes", {"asset": asset if asset.startswith("W") else "W" + asset}
    match = re.fullmatch(r"(?:show|read)(?: me)? (?:the )?news(?: (?:for|about) (btc|eth|sol))?", t)
    if match:
        return "get_news", {"symbol": (match[1] or "btc").upper()}
    match = re.fullmatch(r"analy[sz]e (btc|eth|sol)", t)
    if match:
        return "analyze_market", {"symbol": match[1].upper()}
    match = re.fullmatch(
        r"(?:open|go to|show)(?: the)? (?:(aegis|research|platform) )?(overview|desk|markets|news|strategies|positions|executions|observatory|risk|wallet|settings|sessions)(?: page)?",
        t,
    )
    if match:
        return "open_workspace", {
            "workspace": match[1] or ("research" if match[2] == "news" else "aegis"),
            "page": match[2],
        }
    match = re.fullmatch(
        r"(?:please )?(deposit|withdraw)(?: (\d+(?:\.\d+)?) usdt)?(?: (?:on|to|from) (testnet|mainnet))?",
        t,
    )
    if match:
        return "prepare_wallet_action", {
            "action": match[1],
            "network": match[3] or "testnet",
            **({"amount": match[2]} if match[2] else {}),
        }
    return None
