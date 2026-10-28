"""Lazy exports preserve upstream APIs without loading broker clients for schemas.

Terminal adaptation: importing a schema or researcher must not initialize the
Alpaca Toolkit, Chroma memory or all analyst dependencies.
"""
from importlib import import_module

_MODULES = {
    "Toolkit": "utils.agent_utils", "create_msg_delete": "utils.agent_utils",
    "AgentState": "utils.agent_states", "InvestDebateState": "utils.agent_states",
    "RiskDebateState": "utils.agent_states", "FinancialSituationMemory": "utils.memory",
    "create_fundamentals_analyst": "analysts.fundamentals_analyst",
    "create_market_analyst": "analysts.market_analyst",
    "create_news_analyst": "analysts.news_analyst",
    "create_social_media_analyst": "analysts.social_media_analyst",
    "create_bear_researcher": "researchers.bear_researcher",
    "create_bull_researcher": "researchers.bull_researcher",
    "create_risky_debator": "risk_mgmt.aggresive_debator",
    "create_safe_debator": "risk_mgmt.conservative_debator",
    "create_neutral_debator": "risk_mgmt.neutral_debator",
    "create_research_manager": "managers.research_manager",
    "create_risk_manager": "managers.risk_manager", "create_trader": "trader.trader",
}


def __getattr__(name):
    if name not in _MODULES:
        raise AttributeError(name)
    value = getattr(import_module(f"{__name__}.{_MODULES[name]}"), name)
    globals()[name] = value
    return value

__all__ = [
    "FinancialSituationMemory",
    "Toolkit",
    "AgentState",
    "create_msg_delete",
    "InvestDebateState",
    "RiskDebateState",
    "create_bear_researcher",
    "create_bull_researcher",
    "create_research_manager",
    "create_fundamentals_analyst",
    "create_market_analyst",
    "create_neutral_debator",
    "create_news_analyst",
    "create_risky_debator",
    "create_risk_manager",
    "create_safe_debator",
    "create_social_media_analyst",
    "create_trader",
]
