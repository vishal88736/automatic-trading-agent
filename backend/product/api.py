"""Private product API. Fastify verifies Cognito and signs each forwarded request."""

import asyncio
import hashlib
import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from httpx import HTTPError
from psycopg import Connection
from psycopg import Error as DatabaseError
from pydantic import Field, TypeAdapter

from backend.data import Providers, fixture_news
from backend.models import Model
from backend.product.accounts import DEFAULT_INITIAL_USDT, PaperAccount, ensure_account, get_account
from backend.product.agents import (
    AgentCommand,
    AgentStart,
    DraftAgentStart,
    LeaderboardScope,
    close_agent_position,
    control_agent,
    leaderboard,
    list_agents,
    position_asset,
    start_agent,
    start_draft_agent,
    timeline,
)
from backend.product.backtests import get_replay, save_replay
from backend.product.database import DSN_ENV, open_database
from backend.product.execution import (
    Asset,
    OrderRequest,
    PaperTerms,
    cancel_order,
    get_order,
    order_history,
    portfolio,
    positions,
    process_limit,
    reset_account,
    set_emergency,
    submit_order,
)
from backend.product.history import HistoricalBacktestRequest, load_candles
from backend.product.market import load_quotes
from backend.product.news_hub import NewsHub, fixture_pulse
from backend.product.rules import StrategyDraft, authoring_options
from backend.product.strategies import (
    archive_strategy,
    create_strategy,
    get_strategy,
    list_strategies,
    strategy_history,
    update_strategy,
)
from backend.product.users import Credentials, Registration, authenticate, get_user, register
from backend.product.worker import heartbeat_fresh
from backend.settings import get_settings
from backend.storage import Store
from backend.strategies import indicators

KEY_ENV = "KRONO_PRODUCT_API_KEY"
SERVICE_SUBJECT = UUID(int=0)
BODY_LIMIT = 65536
OpeningCredit = Annotated[Decimal, Field(gt=0, le=100000000, decimal_places=6)]
Version = Annotated[int, Field(ge=1, le=2**31 - 1)]


class StrategyEdit(Model):
    expected_version: Version
    document: StrategyDraft


class StrategyArchive(Model):
    expected_version: Version


class PaperReset(Model):
    epoch: int = Field(ge=1)
    acknowledge: Literal["RESET_PAPER_ACCOUNT"]


class PositionClose(Model):
    request_key: UUID
    epoch: int = Field(ge=1)


class PaperEmergency(Model):
    enabled: bool


class ProductError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message


def create_product_api(
    dsn: str,
    key: str,
    initial_usdt: Decimal = DEFAULT_INITIAL_USDT,
    *,
    history_source=load_candles,
    quote_source=load_quotes,
    fixture_feeds=False,
    news_hub=True,
) -> FastAPI:
    if not dsn or len(key.encode()) < 32:
        raise ValueError(
            "Configure the platform database and a product API key of at least 32 bytes"
        )
    initial_usdt = TypeAdapter(OpeningCredit).validate_python(initial_usdt)

    @asynccontextmanager
    async def lifespan(application):
        cache = Store(":memory:")
        feeds = Providers(
            cache,
            market_provider="fixture" if fixture_feeds else "coinbase",
            news_provider="fixture" if fixture_feeds else "cryptocurrency.cv",
            news_key=os.environ.get("NEWS_API_KEY", ""),
        )
        application.state.feeds = feeds
        hub = NewsHub(get_settings().providers.news_base_url, stream=not fixture_feeds)
        if fixture_feeds:
            for article in fixture_news().articles:
                hub.articles[article.id] = article
        elif news_hub:
            await hub.start()
        application.state.news = hub
        try:
            yield
        finally:
            await hub.stop()
            await feeds.close()
            cache.close()

    app = FastAPI(
        title="Krono Product API",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @app.get("/healthz")
    def health():
        try:
            with open_database(dsn) as db:
                (ready,) = db.execute(
                    "SELECT to_regclass('paper_worker_heartbeats') IS NOT NULL"
                ).fetchone()
        except DatabaseError:
            ready = False
        return JSONResponse({"ready": ready}, status_code=200 if ready else 503)

    @app.exception_handler(ProductError)
    async def product_error(_request, exc):
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, exc):
        return JSONResponse(
            {
                "error": {
                    "code": "VALIDATION",
                    "message": "Invalid request",
                    "fields": [
                        {"path": ".".join(map(str, error["loc"])), "message": error["msg"]}
                        for error in exc.errors()
                    ],
                }
            },
            status_code=422,
        )

    @app.exception_handler(DatabaseError)
    async def database_error(_request, _exc):
        return JSONResponse(
            {"error": {"code": "DATABASE_UNAVAILABLE", "message": "Product database unavailable"}},
            status_code=503,
        )

    @app.exception_handler(LookupError)
    async def missing_strategy(_request, _exc):
        return JSONResponse(
            {"error": {"code": "NOT_FOUND", "message": "Strategy is unavailable"}},
            status_code=404,
        )

    @app.exception_handler(ValueError)
    async def conflict(_request, _exc):
        return JSONResponse(
            {"error": {"code": "CONFLICT", "message": "Reload the record and review the request"}},
            status_code=409,
        )

    async def owner(request: Request) -> UUID:
        denied = ProductError(401, "UNAUTHENTICATED", "Invalid platform identity")
        subject = request.headers.get("x-krono-product-sub", "")
        expires = request.headers.get("x-krono-product-expires", "")
        signature = request.headers.get("x-krono-product-signature", "")
        try:
            identity = UUID(subject)
            if not expires.isascii() or not expires.isdecimal() or len(expires) > 12:
                raise denied
            if not 0 < int(expires) - time.time() <= 30:
                raise denied
        except ValueError:
            raise denied from None
        if len(signature) != 64 or not signature.isascii():
            raise denied
        body_hash = hashlib.sha256()
        size = 0
        async for part in request.stream():
            size += len(part)
            if size > BODY_LIMIT:
                raise ProductError(
                    413, "REQUEST_TOO_LARGE", "Request body exceeds the allowed size"
                )
            body_hash.update(part)
        path = request.scope["raw_path"]
        if query := request.scope["query_string"]:
            path += b"?" + query
        message = b"\n".join(
            (
                expires.encode(),
                subject.encode(),
                request.method.encode(),
                path,
                body_hash.hexdigest().encode(),
            )
        )
        expected = hmac.new(key.encode(), message, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise denied
        return identity

    def database():
        with open_database(dsn) as db:
            db.execute("SET statement_timeout = '5s'")
            yield db

    Principal = Annotated[UUID, Depends(owner)]
    Database = Annotated[Connection, Depends(database)]

    def gateway_service(subject: Principal) -> None:
        # Account routes are reserved for the gateway, which signs them as the nil subject.
        if subject != SERVICE_SUBJECT:
            raise ProductError(403, "FORBIDDEN", "Gateway service route")

    Service = Annotated[None, Depends(gateway_service)]

    @app.post("/platform/internal/users", status_code=201)
    def user_register(request: Registration, _: Service, db: Database):
        try:
            return {"user": register(db, request)}
        except ValueError as exc:
            raise ProductError(409, "ACCOUNT_EXISTS", str(exc)) from None

    @app.post("/platform/internal/sessions")
    def user_login(credentials: Credentials, _: Service, db: Database):
        user = authenticate(db, credentials)
        if user is None:
            raise ProductError(401, "INVALID_CREDENTIALS", "Email or password is incorrect")
        return {"user": user}

    @app.get("/platform/internal/users/{user_id}")
    def user_profile(user_id: UUID, _: Service, db: Database):
        user = get_user(db, user_id)
        if user is None:
            raise ProductError(404, "NOT_FOUND", "Account is unavailable")
        return {"user": user}

    @app.get("/platform/leaderboard")
    def agent_leaderboard(
        subject: Principal,
        db: Database,
        scope: LeaderboardScope = "active",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
    ):
        return financial(
            {"items": leaderboard(db, subject, scope, limit), "worker_online": heartbeat_fresh(db)}
        )

    @app.get("/platform/paper-account")
    def paper_account(subject: Principal, db: Database) -> dict[str, PaperAccount | None]:
        return {"account": get_account(db, subject)}

    @app.post("/platform/paper-account")
    def provision_paper_account(subject: Principal, db: Database) -> dict[str, PaperAccount]:
        return {"account": ensure_account(db, subject, initial_usdt)}

    def financial(data, status=200):
        return JSONResponse(
            jsonable_encoder(data, custom_encoder={Decimal: str}), status_code=status
        )

    def quotes_for(db, subject, asset=None):
        account = get_account(db, subject)
        if account is None:
            raise ProductError(409, "ACCOUNT_REQUIRED", "Open a paper account first")
        symbols = {
            symbol
            for symbol, item in positions(db, subject, account.epoch).items()
            if item["quantity"] > 0
        }
        if asset:
            symbols.add(asset)
        return quote_source(symbols)

    @app.get("/platform/paper-portfolio")
    def paper_portfolio(subject: Principal, db: Database):
        return financial(portfolio(db, subject, quotes_for(db, subject)))

    @app.get("/platform/paper-orders")
    def paper_order_history(
        subject: Principal,
        db: Database,
        epoch: Annotated[int | None, Query(ge=1)] = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
    ):
        return financial({"items": order_history(db, subject, epoch=epoch, limit=limit)})

    @app.post("/platform/paper-orders", status_code=201)
    def paper_order_submit(order: OrderRequest, subject: Principal, db: Database):
        quotes = quotes_for(db, subject, order.asset)
        return financial(submit_order(db, subject, order, quotes, PaperTerms()), 201)

    @app.post("/platform/paper-orders/{order_id}/cancel")
    def paper_order_cancel(order_id: UUID, subject: Principal, db: Database):
        order = cancel_order(db, subject, order_id)
        if order is None:
            raise ProductError(404, "NOT_FOUND", "Paper order is unavailable")
        return financial(order)

    @app.post("/platform/paper-orders/{order_id}/evaluate")
    def paper_order_evaluate(order_id: UUID, subject: Principal, db: Database):
        order = get_order(db, subject, order_id)
        if order is None:
            raise ProductError(404, "NOT_FOUND", "Paper order is unavailable")
        if order["status"] == "OPEN":
            quotes = quotes_for(db, subject, order["request"]["asset"])
            order = process_limit(db, subject, order_id, quotes, PaperTerms())
        return financial(order)

    @app.post("/platform/paper-account/reset")
    def paper_reset(reset: PaperReset, subject: Principal, db: Database) -> dict[str, PaperAccount]:
        return {"account": reset_account(db, subject, reset.epoch, initial_usdt)}

    @app.put("/platform/paper-account/emergency")
    def paper_emergency(change: PaperEmergency, subject: Principal, db: Database):
        return {"emergency_stop": set_emergency(db, subject, change.enabled)}

    @app.get("/platform/paper-agents")
    def paper_agent_list(subject: Principal, db: Database):
        return financial({"items": list_agents(db, subject), "worker_online": heartbeat_fresh(db)})

    @app.post("/platform/paper-agents", status_code=201)
    def paper_agent_start(request: AgentStart, subject: Principal, db: Database):
        try:
            agent = start_agent(db, subject, request)
        except LookupError:
            raise ProductError(404, "NOT_FOUND", "Strategy or backtest is unavailable") from None
        except ValueError as exc:
            raise ProductError(409, "AGENT_START_REJECTED", str(exc)) from None
        return {"id": agent}

    @app.post("/platform/paper-agents/{agent_id}/control")
    def paper_agent_control(
        agent_id: UUID, command: AgentCommand, subject: Principal, db: Database
    ):
        try:
            return {"status": control_agent(db, subject, agent_id, command.action)}
        except LookupError:
            raise ProductError(404, "NOT_FOUND", "Paper agent is unavailable") from None
        except ValueError as exc:
            raise ProductError(409, "AGENT_CONTROL_REJECTED", str(exc)) from None

    @app.post("/platform/paper-agents/{agent_id}/close-position")
    def paper_agent_close(agent_id: UUID, command: PositionClose, subject: Principal, db: Database):
        try:
            asset = position_asset(db, subject, agent_id)
            quotes = quotes_for(db, subject, asset)
            return financial(
                close_agent_position(
                    db, subject, agent_id, command.request_key, command.epoch, quotes
                )
            )
        except LookupError:
            raise ProductError(404, "NOT_FOUND", "Paper agent is unavailable") from None
        except ValueError as exc:
            raise ProductError(409, "CLOSE_REJECTED", str(exc)) from None

    @app.get("/platform/paper-agents/{agent_id}/events")
    def paper_agent_timeline(
        agent_id: UUID,
        subject: Principal,
        db: Database,
        after: Annotated[int, Query(ge=0)] = 0,
    ):
        return financial({"items": timeline(db, subject, agent_id, after)})

    @app.get("/platform/paper-agents/{agent_id}/stream")
    async def paper_agent_stream(
        agent_id: UUID,
        request: Request,
        subject: Principal,
        after: Annotated[int, Query(ge=0)] = 0,
    ):
        def latest(cursor):
            with open_database(dsn) as db:
                return timeline(db, subject, agent_id, cursor)

        async def events():
            cursor = after
            yield ": connected\n\n"
            until = time.monotonic() + 20
            while time.monotonic() < until and not await request.is_disconnected():
                rows = await asyncio.to_thread(latest, cursor)
                for row in reversed(rows):
                    cursor = row["seq"]
                    data = json.dumps(jsonable_encoder(row), separators=(",", ":"))
                    yield f"id: {cursor}\ndata: {data}\n\n"
                await asyncio.sleep(2)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"cache-control": "no-store", "x-accel-buffering": "no"},
        )

    @app.get("/platform/paper-market/{asset}")
    async def paper_market(asset: Asset, request: Request, subject: Principal):
        market = await request.app.state.feeds.market(asset)
        technical = None
        if market.status in {"AVAILABLE", "FIXTURE"}:
            try:
                technical = await asyncio.to_thread(indicators, market)
            except ValueError:
                pass
        return {"market": market, "indicators": technical}

    @app.get("/platform/paper-news")
    async def paper_news(
        request: Request,
        subject: Principal,
        asset: Asset | None = None,
        breaking: bool = False,
        refresh: bool = False,
    ):
        feed = await request.app.state.feeds.news(breaking=breaking, refresh=refresh)
        if asset is not None:
            return feed.model_copy(
                update={
                    "articles": [article for article in feed.articles if asset in article.assets]
                }
            )
        return feed

    @app.get("/platform/news/live")
    def news_live(
        request: Request,
        subject: Principal,
        asset: Asset | None = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
    ):
        hub: NewsHub = request.app.state.news
        return {**hub.status(), "items": hub.snapshot(asset, limit)}

    @app.get("/platform/news/stream")
    async def news_stream(request: Request, subject: Principal, asset: Asset | None = None):
        hub: NewsHub = request.app.state.news
        queue = hub.subscribe()

        async def events():
            try:
                yield ": connected\n\n"
                # Clients reconnect automatically; bounded sessions keep proxies healthy.
                until = time.monotonic() + 120
                while time.monotonic() < until and not await request.is_disconnected():
                    try:
                        article = await asyncio.wait_for(queue.get(), timeout=15)
                    except TimeoutError:
                        yield ": heartbeat\n\n"
                        continue
                    if asset and asset not in article.assets:
                        continue
                    data = json.dumps(jsonable_encoder(article), separators=(",", ":"))
                    yield f"event: article\nid: {article.id}\ndata: {data}\n\n"
            finally:
                hub.unsubscribe(queue)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"cache-control": "no-store", "x-accel-buffering": "no"},
        )

    @app.get("/platform/news/pulse")
    async def news_pulse(request: Request, subject: Principal):
        if fixture_feeds:
            return fixture_pulse()
        return await request.app.state.news.pulse()

    @app.get("/platform/paper-watchlist")
    def paper_watchlist(subject: Principal, db: Database):
        rows = db.execute(
            "SELECT asset FROM platform_watchlist WHERE owner_id = %s ORDER BY asset",
            (subject,),
        ).fetchall()
        return {"assets": [asset for (asset,) in rows]}

    @app.put("/platform/paper-watchlist/{asset}")
    def paper_watch(subject: Principal, db: Database, asset: Asset, change: PaperEmergency):
        ensure_account(db, subject, initial_usdt)
        if change.enabled:
            db.execute(
                "INSERT INTO platform_watchlist VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (subject, asset),
            )
        else:
            db.execute(
                "DELETE FROM platform_watchlist WHERE owner_id = %s AND asset = %s",
                (subject, asset),
            )
        return {"asset": asset, "enabled": change.enabled}

    @app.get("/platform/strategy-authoring")
    def strategy_authoring(subject: Principal):
        return authoring_options()

    @app.post("/platform/strategy-authoring/validate")
    def validate_draft(draft: StrategyDraft, subject: Principal):
        return {"document": draft}

    @app.post("/platform/strategy-authoring/start-agent", status_code=201)
    def start_agent_from_draft(request: DraftAgentStart, subject: Principal, db: Database):
        try:
            agent, strategy = start_draft_agent(db, subject, request)
        except ValueError as exc:
            raise ProductError(409, "AGENT_START_REJECTED", str(exc)) from None
        return {"id": agent, "strategy": strategy}

    @app.get("/platform/custom-strategies")
    def strategies(
        subject: Principal,
        db: Database,
        after: UUID | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
    ):
        return {"items": list_strategies(db, subject, after=after, limit=limit)}

    @app.post("/platform/custom-strategies", status_code=201)
    def new_strategy(document: StrategyDraft, subject: Principal, db: Database):
        ensure_account(db, subject, initial_usdt)
        return create_strategy(db, subject, document)

    @app.get("/platform/custom-strategies/{strategy_id}")
    def strategy(
        strategy_id: UUID,
        subject: Principal,
        db: Database,
        version: Annotated[int | None, Query(ge=1, le=2**31 - 1)] = None,
    ):
        stored = get_strategy(db, subject, strategy_id, version)
        if stored is None:
            raise LookupError
        return stored

    @app.put("/platform/custom-strategies/{strategy_id}")
    def edit_strategy(strategy_id: UUID, edit: StrategyEdit, subject: Principal, db: Database):
        return update_strategy(
            db, subject, strategy_id, edit.document, expected_version=edit.expected_version
        )

    @app.post("/platform/custom-strategies/{strategy_id}/archive", status_code=204)
    def remove_strategy(
        strategy_id: UUID, archive: StrategyArchive, subject: Principal, db: Database
    ):
        archive_strategy(db, subject, strategy_id, expected_version=archive.expected_version)

    @app.get("/platform/custom-strategies/{strategy_id}/versions")
    def versions(
        strategy_id: UUID,
        subject: Principal,
        db: Database,
        before: Annotated[int, Query(ge=2, le=2**31)] = 2**31,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
    ):
        if get_strategy(db, subject, strategy_id, 1) is None:
            raise LookupError
        return {
            "items": strategy_history(db, subject, strategy_id, before_version=before, limit=limit)
        }

    @app.post("/platform/custom-strategies/{strategy_id}/backtests", status_code=201)
    def create_backtest(
        strategy_id: UUID, study: HistoricalBacktestRequest, subject: Principal, db: Database
    ):
        strategy = get_strategy(db, subject, strategy_id, study.version)
        if strategy is None:
            raise LookupError
        try:
            market = history_source(strategy.document.definition.asset, study.start, study.end)
            return save_replay(db, subject, strategy, study, market)
        except HTTPError:
            raise ProductError(
                503, "HISTORY_UNAVAILABLE", "Historical market data unavailable"
            ) from None
        except ValueError as exc:
            raise ProductError(422, "REPLAY_REJECTED", str(exc)) from None

    @app.get("/platform/backtests/{run_id}")
    def backtest_report(
        run_id: UUID, subject: Principal, db: Database, include_dataset: bool = False
    ):
        report = get_replay(db, subject, run_id, include_dataset=include_dataset)
        if report is None:
            raise ProductError(404, "NOT_FOUND", "Backtest is unavailable")
        return report

    return app


def app_from_environment():
    return create_product_api(
        os.environ.get(DSN_ENV, ""),
        os.environ.get(KEY_ENV, ""),
        TypeAdapter(OpeningCredit).validate_python(
            os.environ.get("KRONO_PAPER_INITIAL_USDT", str(DEFAULT_INITIAL_USDT))
        ),
    )
