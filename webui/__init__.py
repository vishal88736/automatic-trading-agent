"""
Trading Agents Framework - Web UI Package
"""


def __getattr__(name):
    # Lazy so that importing webui submodules (e.g. webui.utils.prompt_capture
    # from tradingagents.agents) does not build the Dash app, which fetches
    # Alpaca account data.
    if name == "run_app":
        from webui.app_dash import run_app

        return run_app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
