"""Website operations behind the same models, stores and services as the HTTP controls."""

from __future__ import annotations

import asyncio
from decimal import Decimal

from fastapi.encoders import jsonable_encoder

from aegis.history import TradeFilters
from aegis.nl.website import ARCHIVES, SCHEMAS, archive_result
from backend.backtesting import backtest
from backend.desk import AlertRequest
from backend.models import BacktestRequest, RunRequest, StrategyConfig, now
from backend.strategies import REGISTRY
from backend.trade_history import research_history


async def run_backtest(engine, body: BacktestRequest):
    market, feed = await asyncio.gather(
        engine.providers.market(body.symbol), engine.providers.news()
    )
    config, version = engine.store.config("strategy:" + body.strategy_id)
    result = await asyncio.to_thread(
        backtest,
        market,
        feed,
        body,
        StrategyConfig.model_validate(config),
        engine.execution.risk()[0],
    )
    result["config_version"] = version
    prior = engine.store.get("cache", "strategy_performance:" + body.symbol) or {}
    prior[body.strategy_id] = {
        "out_of_sample": True,
        "asset": body.symbol,
        "source": market.source,
        "trade_count": result["out_of_sample"]["trade_count"],
        "net_return": result["out_of_sample"]["total_return"],
        "max_drawdown": result["out_of_sample"]["maximum_drawdown"],
        "evaluated_at": now().isoformat(),
        "config_version": version,
    }
    engine.store.put("cache", "strategy_performance:" + body.symbol, prior)
    engine.store.audit(
        "backtest.completed",
        {
            "strategy_id": body.strategy_id,
            "symbol": body.symbol,
            "source": market.source,
            "out_of_sample": result["out_of_sample"]["total_return"],
        },
    )
    return result


async def execute(engine, name: str, arguments: dict, *, save_strategy):
    args = SCHEMAS[name][0].model_validate(arguments).model_dump(mode="json")
    if name in ARCHIVES:
        if args.pop("workspace") != "research":
            raise ValueError("Choose the AEGIS assistant for its separate execution archive")
        data = research_history(engine.store, TradeFilters.model_validate(args)).model_dump(
            mode="json"
        )
        result = archive_result(name, "research", data)
    elif name == "get_library_strategies":
        rows = []
        for identifier, metadata in REGISTRY.items():
            config, version = engine.store.config("strategy:" + identifier)
            rows.append(
                {"id": identifier, "name": metadata["name"], "config": config, "version": version}
            )
        result = {
            "items": rows,
            "summary": "; ".join(
                f"{row['name']}: {'enabled' if row['config']['enabled'] else 'disabled'}"
                for row in rows
            ),
        }
    elif name == "set_library_strategy_enabled":
        identifier = args["strategy_id"]
        current, version = engine.store.config("strategy:" + identifier)
        config = StrategyConfig.model_validate({**current, "enabled": args["enabled"]})
        saved = save_strategy(engine, identifier, config, version)
        result = {
            "strategy_id": identifier,
            "enabled": config.enabled,
            "version": saved,
            "summary": f"{REGISTRY[identifier]['name']} {'enabled' if config.enabled else 'disabled'}. AEGIS entry selection, target assets and risk checks still apply; existing positions keep their exit checks.",
        }
    elif name == "run_backtest":
        result = await run_backtest(engine, BacktestRequest.model_validate(args))
        result["summary"] = (
            f"Historical backtest completed for {args['strategy_id']} on {args['symbol']}; measured holdout results are attached. This placed no live order."
        )
    elif name == "get_alerts":
        result = {
            **engine.alerts.view(),
            "summary": f"{engine.alerts.view()['total']} saved research price alert(s).",
        }
    elif name == "create_alert":
        await engine.refresh_markets()
        alert = engine.alerts.create(
            AlertRequest(symbol=args["symbol"], condition=args["condition"], target=args["price"]),
            engine.markets,
        )
        result = {
            "alert": alert,
            "summary": f"Alert {alert.id} created for {alert.symbol} {alert.condition.lower()} {alert.target}. This is a notification, not an order.",
        }
    elif name == "delete_alert":
        result = {
            **engine.alerts.delete(args["alert_id"]),
            "summary": f"Price alert {args['alert_id']} deleted.",
        }
    elif name == "get_news":
        feed = await engine.providers.news()
        articles = [
            article
            for article in feed.articles
            if not article.assets or args["symbol"] in article.assets
        ]
        result = {
            "status": feed.status,
            "source": feed.source,
            "articles": articles[:20],
            "summary": f"News source {feed.source}: {feed.status}. Showing {min(20, len(articles))} available article(s) for {args['symbol']}.",
        }
    elif name == "analyze_market":
        result = await engine.run(RunRequest(symbol=args["symbol"]))
        result["summary"] = (
            f"Research analysis {result['id']} finished with status {result['status']}. Review its evidence in the Observatory; no fill was authorized by this command."
        )
    else:
        raise ValueError("Unregistered website operation")
    engine.store.audit("assistant.website_tool", {"tool": name})
    return jsonable_encoder(result, custom_encoder={Decimal: str})
