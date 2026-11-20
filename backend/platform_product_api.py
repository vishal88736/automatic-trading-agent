"""Private product API. Fastify verifies Cognito and signs each forwarded request."""

import hashlib
import hmac
import os
import time
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from httpx import HTTPError
from psycopg import Connection
from psycopg import Error as DatabaseError
from pydantic import Field, TypeAdapter

from backend.backtest_repository import get_replay, save_replay
from backend.historical_data import HistoricalBacktestRequest, load_candles
from backend.models import Model
from backend.paper_accounts import DEFAULT_INITIAL_USDT, PaperAccount, ensure_account, get_account
from backend.paper_agents import (
    AgentCommand,
    AgentStart,
    control_agent,
    list_agents,
    start_agent,
    timeline,
)
from backend.paper_execution import (
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
from backend.paper_market import load_quotes
from backend.platform_db import DSN_ENV, open_database
from backend.strategy_repository import (
    archive_strategy,
    create_strategy,
    get_strategy,
    list_strategies,
    strategy_history,
    update_strategy,
)
from backend.strategy_rules import StrategyDraft, authoring_options

KEY_ENV = "KRONO_PRODUCT_API_KEY"
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
) -> FastAPI:
    if not dsn or len(key.encode()) < 32:
        raise ValueError(
            "Configure the platform database and a product API key of at least 32 bytes"
        )
    initial_usdt = TypeAdapter(OpeningCredit).validate_python(initial_usdt)
    app = FastAPI(title="Krono Product API", docs_url=None, redoc_url=None, openapi_url=None)

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
        return financial({"items": list_agents(db, subject)})

    @app.post("/platform/paper-agents", status_code=201)
    def paper_agent_start(request: AgentStart, subject: Principal, db: Database):
        try:
            agent = start_agent(db, subject, request)
        except LookupError:
            raise ProductError(404, "NOT_FOUND", "Backtest is unavailable") from None
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

    @app.get("/platform/paper-agents/{agent_id}/events")
    def paper_agent_timeline(
        agent_id: UUID,
        subject: Principal,
        db: Database,
        after: Annotated[int, Query(ge=0)] = 0,
    ):
        return financial({"items": timeline(db, subject, agent_id, after)})

    @app.get("/platform/strategy-authoring")
    def strategy_authoring(subject: Principal):
        return authoring_options()

    @app.post("/platform/strategy-authoring/validate")
    def validate_draft(draft: StrategyDraft, subject: Principal):
        return {"document": draft}

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
