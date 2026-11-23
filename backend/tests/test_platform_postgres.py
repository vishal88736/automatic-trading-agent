"""Integration tests for product state on a disposable PostgreSQL database."""

import hashlib
import hmac
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from decimal import Decimal
from threading import Barrier
from uuid import uuid4

import pytest

TEST_DSN = os.getenv("KRONO_TEST_DATABASE_DSN")

if not TEST_DSN:
    pytest.skip(
        "KRONO_TEST_DATABASE_DSN is required for PostgreSQL integration", allow_module_level=True
    )

from fastapi.testclient import TestClient  # noqa: E402
from psycopg import sql  # noqa: E402
from psycopg.conninfo import make_conninfo  # noqa: E402
from psycopg.errors import CheckViolation, ForeignKeyViolation, SyntaxError  # noqa: E402

from backend.data import fixture_market  # noqa: E402
from backend.product.accounts import ensure_account, get_account  # noqa: E402
from backend.product.api import create_product_api  # noqa: E402
from backend.product.database import MIGRATIONS, migrate, open_database  # noqa: E402
from backend.product.rules import StrategyDraft  # noqa: E402
from backend.product.strategies import (  # noqa: E402
    archive_strategy,
    create_strategy,
    get_strategy,
    list_strategies,
    strategy_history,
    update_strategy,
)


@pytest.fixture
def database_dsn():
    schema = "test_" + uuid4().hex
    identifier = sql.Identifier(schema)
    with open_database(TEST_DSN) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(identifier))
        try:
            yield make_conninfo(TEST_DSN, options=f"-c search_path={schema}")
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(identifier))


@pytest.fixture
def database(database_dsn):
    @contextmanager
    def connect():
        with open_database(database_dsn) as db:
            yield db

    return connect


def test_migrations_are_repeatable_and_rollback_failed_upgrade(database, tmp_path):
    with database() as db:
        assert migrate(db) == [file.stem for file in sorted(MIGRATIONS.glob("*.sql"))]
        owner = uuid4()
        funded = ensure_account(db, owner)

        for file in MIGRATIONS.glob("*.sql"):
            (tmp_path / file.name).write_bytes(file.read_bytes())
        assert migrate(db, tmp_path) == []
        (tmp_path / "9000_valid.sql").write_text("CREATE TABLE sample (id INTEGER);")
        broken = tmp_path / "9001_invalid.sql"
        broken.write_text("CREATE TABLE bad_;")
        with pytest.raises(SyntaxError):
            migrate(db, tmp_path)
        assert db.execute("SELECT to_regclass('sample')").fetchone() == (None,)
        assert get_account(db, owner) == funded

        broken.unlink()
        assert migrate(db, tmp_path) == ["9000_valid"]
        (tmp_path / "0001_paper_accounts.sql").write_text("SELECT 1;")
        with pytest.raises(ValueError, match="migration history differs"):
            migrate(db, tmp_path)


def test_concurrent_provisioning_posts_one_opening_credit(database):
    with database() as db:
        migrate(db)
    owner = uuid4()
    initial = Decimal("1234.123456")
    simultaneous = Barrier(4, timeout=10)

    def provision():
        with database() as db:
            simultaneous.wait()
            return ensure_account(db, owner, initial)

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: provision(), range(4)))
    assert all(account == results[0] for account in results)
    assert results[0].cash == initial
    with database() as db:
        assert ensure_account(db, owner, Decimal("4321")) == results[0]
        assert db.execute("SELECT COUNT(*) FROM paper_ledger_entries").fetchone() == (1,)


def test_account_ownership_and_credit_precision_are_enforced(database):
    owner, other = uuid4(), uuid4()
    with database() as db:
        migrate(db)
        funded = ensure_account(db, owner)
        assert get_account(db, other) is None
        with pytest.raises(CheckViolation):
            ensure_account(db, other, Decimal("1.0000001"))
        assert get_account(db, other) is None
        assert db.execute("SELECT COUNT(*) FROM platform_users").fetchone() == (1,)

        separate = ensure_account(db, other)
        assert separate.id != funded.id
        with pytest.raises(ForeignKeyViolation):
            db.execute(
                """
                INSERT INTO paper_ledger_entries (owner_id, account_id, epoch, kind, amount)
                VALUES (%s, %s, 1, 'OPENING_CREDIT', 10)
                """,
                (other, funded.id),
            )


@pytest.fixture
def strategy_draft():
    return StrategyDraft.model_validate(
        {
            "name": "RSI",
            "definition": {
                "asset": "BTC",
                "entry": {
                    "conditions": [{"indicator": "rsi", "operator": "lt", "threshold": "30"}]
                },
                "exit": {
                    "conditions": [
                        {"indicator": "rsi", "operator": "crosses_above", "threshold": "65"}
                    ]
                },
                "stop_loss": "0.04",
                "cash_fraction": "0.02",
            },
        }
    )


def test_strategy_versions_preserve_history_and_are_tenant_scoped(database, strategy_draft):
    owner, other = uuid4(), uuid4()
    draft = strategy_draft
    with database() as db:
        migrate(db)
        ensure_account(db, owner)
        ensure_account(db, other)
        original = create_strategy(db, owner, draft)
        assert list_strategies(db, owner) == [original]
        assert list_strategies(db, owner, after=original.id) == []
        assert list_strategies(db, other) == []
        assert get_strategy(db, other, original.id) is None
        assert not strategy_history(db, other, original.id)
        with pytest.raises(LookupError):
            update_strategy(db, other, original.id, draft, expected_version=1)

        assert update_strategy(db, owner, original.id, draft, expected_version=1) == original
        edited = draft.model_copy(update={"name": "RSI revision"})
        revision = update_strategy(db, owner, original.id, edited, expected_version=1)
        assert revision.version == 2
        assert strategy_history(db, owner, original.id) == [revision, original]
        assert strategy_history(db, owner, original.id, before_version=2) == [original]
        with pytest.raises(ValueError, match="version changed"):
            archive_strategy(db, owner, original.id, expected_version=1)
        archive_strategy(db, owner, original.id, expected_version=2)
        assert list_strategies(db, owner) == []
        assert get_strategy(db, owner, original.id) is None
        assert get_strategy(db, owner, original.id, 1) == original
        assert get_strategy(db, other, original.id, 1) is None


def test_authenticated_product_http_checks_identity_payload_and_ownership(
    database_dsn, database, strategy_draft
):
    with database() as db:
        migrate(db)
    owner, other = uuid4(), uuid4()
    key = "signed-product-test-material" * 2
    app = create_product_api(
        database_dsn,
        key,
        Decimal("1250.000001"),
        history_source=lambda symbol, *_: fixture_market(symbol),
        fixture_feeds=True,
    )

    def headers(method, path, subject, body="", ttl=20):
        expires = str(int(time.time()) + ttl)
        checksum = hashlib.sha256(body.encode()).hexdigest()
        message = "\n".join([expires, str(subject), method, path, checksum])
        return {
            "x-krono-product-sub": str(subject),
            "x-krono-product-expires": expires,
            "x-krono-product-signature": hmac.new(
                key.encode(), message.encode(), hashlib.sha256
            ).hexdigest(),
            "content-type": "application/json",
        }

    with TestClient(app) as client:

        def call(method, path, subject=owner, payload=None):
            data = "" if payload is None else json.dumps(payload)
            return client.request(
                method, path, headers=headers(method, path, subject, data), content=data
            )

        account = "/platform/paper-account"
        assert client.get(account).status_code == 401
        assert (
            client.get(account, headers=headers("GET", account, owner, ttl=-1)).status_code == 401
        )
        assert call("GET", account).json() == {"account": None}
        funded = call("POST", account)
        assert funded.status_code == 200, funded.text
        assert funded.json()["account"]["cash"] == "1250.000001"
        assert call("POST", account).json() == funded.json()
        assert call("GET", account, other).json() == {"account": None}

        watch = "/platform/paper-watchlist"
        assert call("PUT", watch + "/ETH", payload={"enabled": True}).status_code == 200
        assert call("GET", watch).json() == {"assets": ["ETH"]}
        assert call("GET", watch, other).json() == {"assets": []}
        assert call("GET", "/platform/paper-market/BTC").json()["market"]["status"] == "FIXTURE"
        feed = call("GET", "/platform/paper-news?asset=BTC").json()
        assert feed["status"] == "FIXTURE"
        assert all("BTC" in row["assets"] for row in feed["articles"])
        assert client.get("/healthz").json() == {"ready": True}

        strategies = "/platform/custom-strategies"
        draft = strategy_draft.model_dump(mode="json")
        signed = headers("POST", strategies, owner, json.dumps(draft))
        tampered = json.dumps({**draft, "name": "changed"})
        assert client.post(strategies, headers=signed, content=tampered).status_code == 401
        first = call("POST", strategies, payload=draft)
        assert first.status_code == 201, first.text
        record = f"{strategies}/{first.json()['id']}"
        assert call("GET", record, other).status_code == 404
        assert call("GET", strategies, other).json()["items"] == []
        assert call("GET", strategies + "?limit=1").json()["items"] == [first.json()]
        market = fixture_market("BTC")
        study = {
            "version": 1,
            "start": market.candles[81].timestamp.isoformat(),
            "end": market.candles[-1].closed_at.isoformat(),
            "initial_equity": "10000",
        }
        backtest = call("POST", record + "/backtests", payload=study)
        assert backtest.status_code == 201, backtest.text
        result = backtest.json()
        assert result["strategy_id"] == first.json()["id"] and result["strategy_version"] == 1
        assert result["dataset"]["candle_count"] == len(market.candles)
        assert result["dataset"]["evaluation_candle_count"] == len(market.candles) - 81
        assert result["dataset"]["evaluation_start_utc"] == study["start"]
        assert result["dataset"]["evaluation_end_utc"] == study["end"]
        assert result["result"]["fixture"] is True
        report_path = "/platform/backtests/" + result["id"]
        assert call("GET", report_path).json() == result
        assert call("GET", report_path, other).status_code == 404
        assert call("POST", record + "/backtests", other, study).status_code == 404
        assert call("GET", report_path + "?include_dataset=true").json()["market_data"]["candles"][
            0
        ] == market.candles[0].model_dump(mode="json")
        invalid = call("POST", strategies, payload={**draft, "owner_id": str(other)})
        assert invalid.status_code == 422
        assert str(other) not in invalid.text

        update = {"expected_version": 1, "document": {**draft, "name": "Revision"}}
        assert call("PUT", record, other, update).status_code == 404
        second = call("PUT", record, payload=update)
        assert second.json()["version"] == 2
        assert call("PUT", record, payload=update).status_code == 409
        assert call("GET", record + "/versions").json()["items"] == [second.json(), first.json()]
        assert call("POST", record + "/archive", payload={"expected_version": 2}).status_code == 204
        assert call("GET", record).status_code == 404
        assert call("GET", record + "?version=1").json() == first.json()


def test_order_execution_uses_one_ledger_for_fills_reservations_and_reset(database):
    from datetime import timedelta

    from backend.models import now
    from backend.product.execution import (
        OrderRequest,
        PaperQuote,
        PaperTerms,
        get_order,
        portfolio,
        process_limit,
        reset_account,
        set_emergency,
        submit_order,
    )

    owner, other = uuid4(), uuid4()
    at = now()
    terms = PaperTerms(fee_bps=10, slippage_bps=0)

    def quote(price, when):
        return {"BTC": PaperQuote(asset="BTC", price=price, observed_at=when, source="fixture")}

    with database() as db:
        migrate(db)
        account = ensure_account(db, owner)
        ensure_account(db, other)
        buy = OrderRequest(request_key=uuid4(), epoch=1, asset="BTC", side="BUY", quantity="0.001")
        first = submit_order(db, owner, buy, quote("50000", at), terms, clock=lambda: at)
        assert first["status"] == "FILLED"
        assert first["fee"] == Decimal("0.05")
        assert get_account(db, owner).cash == Decimal("9949.95")
        assert submit_order(db, owner, buy, {}, terms)["id"] == first["id"]
        assert get_order(db, other, first["id"]) is None
        with pytest.raises(CheckViolation):
            db.execute("DELETE FROM paper_ledger_entries WHERE order_id = %s", (first["id"],))

        sell = OrderRequest(
            request_key=uuid4(),
            epoch=1,
            asset="BTC",
            side="SELL",
            quantity="0.001",
            limit_price="55000",
        )
        waiting = submit_order(db, owner, sell, quote("50000", at), terms, clock=lambda: at)
        assert waiting["status"] == "OPEN" and waiting["reserved_quantity"] == Decimal("0.001")
        repeat = sell.model_copy(update={"request_key": uuid4(), "limit_price": None})
        assert (
            submit_order(db, owner, repeat, quote("50000", at), terms, clock=lambda: at)["reason"]
            == "INSUFFICIENT_ASSET"
        )
        later = at + timedelta(minutes=1)
        assert (
            process_limit(db, owner, waiting["id"], quote("60000", at), terms, clock=lambda: later)[
                "status"
            ]
            == "OPEN"
        )
        filled = process_limit(
            db, owner, waiting["id"], quote("60000", later), terms, clock=lambda: later
        )
        assert filled["status"] == "FILLED" and filled["realized_pnl"] == Decimal("9.89")
        assert process_limit(db, owner, waiting["id"], {}, terms)["status"] == "FILLED"
        view = portfolio(db, owner, {})
        assert view["available_cash"] == Decimal("10009.89")
        assert view["holdings"] == [] and view["realized_pnl"] == Decimal("9.89")

        set_emergency(db, owner, True)
        stopped = buy.model_copy(update={"request_key": uuid4()})
        assert (
            submit_order(db, owner, stopped, quote("50000", at), terms, clock=lambda: at)["reason"]
            == "EMERGENCY_STOP"
        )
        assert reset_account(db, owner, account.epoch, Decimal("10000")).epoch == 2
        assert portfolio(db, owner, {})["emergency_stop"]
        assert portfolio(db, owner, {})["cash"] == Decimal("10000")
        assert get_order(db, owner, filled["id"])["status"] == "FILLED"


def test_portfolio_records_metrics_without_backfilling_legacy_snapshots(database):
    from datetime import timedelta

    from backend.models import now
    from backend.product.execution import portfolio

    owner = uuid4()
    at = now()
    with database() as db:
        migrate(db)
        account = ensure_account(db, owner)
        db.execute(
            """
            INSERT INTO paper_equity_snapshots (owner_id, account_id, epoch, observed_at, equity)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (owner, account.id, account.epoch, at - timedelta(days=2), Decimal("9800")),
        )
        current = portfolio(db, owner, {}, clock=lambda: at)
        legacy, recorded = current["history"]
        assert legacy["equity"] == Decimal("9800")
        assert recorded["at"] == at
        assert recorded["daily_pnl"] == Decimal("200")
        for metric in ("available_cash", "realized_pnl", "unrealized_pnl", "daily_pnl", "drawdown"):
            assert legacy[metric] is None
            assert recorded[metric] == current[metric]


def test_parallel_submissions_share_cash_lock(database):
    from backend.models import now
    from backend.product.execution import OrderRequest, PaperQuote, PaperTerms, submit_order

    owner = uuid4()
    with database() as db:
        migrate(db)
        ensure_account(db, owner)
    ready = Barrier(2, timeout=10)
    at = now()
    quote = PaperQuote(asset="BTC", price="50000", observed_at=at, source="fixture")
    request = OrderRequest(request_key=uuid4(), epoch=1, asset="BTC", side="BUY", quantity="0.001")

    def place(_index):
        with database() as db:
            ready.wait()
            return submit_order(db, owner, request, {"BTC": quote}, PaperTerms(), clock=lambda: at)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, retry = pool.map(place, range(2))
    assert first["status"] == "FILLED" and retry == first
    with database() as db:
        assert db.execute(
            "SELECT count(*) FROM paper_ledger_entries WHERE owner_id = %s AND kind = 'BUY'",
            (owner,),
        ).fetchone() == (1,)


def test_durable_agent_lease_recovers_and_shared_execution_stops_atomically(
    database, strategy_draft
):
    from datetime import timedelta

    from backend.models import now
    from backend.product.agents import (
        AgentStart,
        claim_agent,
        close_agent_position,
        control_agent,
        list_agents,
        start_agent,
        timeline,
    )
    from backend.product.backtests import save_replay
    from backend.product.execution import (
        OrderRequest,
        PaperTerms,
        order_history,
        portfolio,
        positions,
        submit_order,
    )
    from backend.product.history import HistoricalBacktestRequest
    from backend.product.worker import PaperWorker
    from tests.e2e.product_api import history, quotes

    owner, other = uuid4(), uuid4()
    raw = strategy_draft.model_dump(mode="json")
    raw["definition"]["entry"]["conditions"] = [
        {"indicator": "price", "operator": "gt", "threshold": "1"}
    ]
    raw["definition"]["exit"]["conditions"] = [
        {"indicator": "price", "operator": "gt", "threshold": "1"}
    ]
    raw["definition"]["max_position_usdt"] = "15"
    draft = StrategyDraft.model_validate(raw)
    market = fixture_market("BTC")
    study = HistoricalBacktestRequest(
        version=1, start=market.candles[81].timestamp, end=market.candles[-1].closed_at
    )
    with database() as db:
        migrate(db)
        ensure_account(db, owner)
        ensure_account(db, other)
        strategy = create_strategy(db, owner, draft)
        report = save_replay(db, owner, strategy, study, market)
        request = AgentStart(
            name="Durable paper test",
            report_id=report["id"],
            epoch=1,
            capital="1000",
            max_daily_loss="0.01",
        )
        with pytest.raises(LookupError):
            start_agent(db, other, request)
        ident = start_agent(db, owner, request)
        assert start_agent(db, owner, request) == ident
        initial = claim_agent(db)
        assert initial["stage"] == "VALIDATE"
        worker = PaperWorker(history, quotes, allow_fixture=True)
        worker.tick(db, initial)
        abandoned = claim_agent(db)
        assert abandoned["stage"] == "MONITOR"
        assert claim_agent(db) is None
        db.execute(
            "UPDATE paper_agents SET lease_until = now() - interval '1 second' WHERE id = %s",
            (ident,),
        )

    # A new process/connection reclaims abandoned work. The old claim is fenced out.
    with database() as db:
        recovered = claim_agent(db)
        assert recovered["recovered"]
        restart = PaperWorker(history, quotes, allow_fixture=True)
        restart.tick(db, abandoned)
        restart.tick(db, recovered)
        restart.tick(db, recovered)
        [fill] = order_history(db, owner)
        assert fill["agent_id"] == ident and fill["status"] == "FILLED"
        assert list_agents(db, other) == [] and timeline(db, other, ident) == []
        held = positions(db, owner, 1, actor_only=True, agent_id=ident)
        [holding] = portfolio(db, owner, quotes({"BTC"}))["positions"]
        assert holding["agent_id"] == ident
        assert holding["agent_name"] == "Durable paper test"
        assert holding["quantity"] == held["BTC"]["quantity"]
        assert holding["mark"] == holding["quantity"] * Decimal("50000")
        assert Decimal("14.99") < held["BTC"]["basis"] <= Decimal("15")
        assert portfolio(db, other, quotes({"BTC"}))["positions"] == []
        [stale] = portfolio(db, owner, {})["positions"]
        assert stale["mark"] is None and stale["unrealized_pnl"] is None
        manual = OrderRequest(
            request_key=uuid4(), epoch=1, asset="BTC", side="SELL", quantity=held["BTC"]["quantity"]
        )
        assert (
            submit_order(db, owner, manual, quotes({"BTC"}), PaperTerms())["reason"]
            == "INSUFFICIENT_ASSET"
        )
        assert {"RECOVERED", "DECISION", "VALIDATION"} <= {
            entry["kind"] for entry in timeline(db, owner, ident)
        }

        db.execute("UPDATE paper_agents SET next_run = now() WHERE id = %s", (ident,))
        cancelled = claim_agent(db)
        assert control_agent(db, owner, ident, "pause") == "PAUSED"
        restart.tick(db, cancelled)
        assert claim_agent(db) is None
        assert control_agent(db, owner, ident, "resume") == "RUNNING"
        after_resume = claim_agent(db)
        assert after_resume["last_quote"] >= now() - timedelta(minutes=1)
        from backend.product.execution import PaperQuote

        low = PaperWorker(
            history,
            lambda _assets: {
                "BTC": PaperQuote(asset="BTC", price="100", observed_at=now(), source="fixture")
            },
            allow_fixture=True,
        )
        low.tick(db, after_resume)
        assert list_agents(db, owner)[0]["status"] == "PAUSED"
        assert any(
            entry["detail"].get("reason") == "AGENT_DAILY_LOSS"
            for entry in timeline(db, owner, ident)
        )
        assert control_agent(db, owner, ident, "stop") == "STOPPED"
        restart.tick(db, after_resume)
        assert claim_agent(db) is None
        assert [row["status"] for row in order_history(db, owner)].count("FILLED") == 1
        key = uuid4()
        close = close_agent_position(db, owner, ident, key, 1, quotes({"BTC"}))
        assert close["status"] == "FILLED"
        assert close_agent_position(db, owner, ident, key, 1, {}) == close
        assert positions(db, owner, 1, actor_only=True, agent_id=ident)["BTC"]["quantity"] == 0
        assert portfolio(db, owner, quotes({"BTC"}))["positions"] == []


def test_start_from_draft_is_atomic_idempotent_and_owner_scoped(database, strategy_draft):
    from backend.product.agents import DraftAgentStart, list_agents, start_draft_agent, timeline
    from backend.product.execution import set_emergency

    owner, other = uuid4(), uuid4()
    request = DraftAgentStart(
        name="Draft test agent", epoch=1, document=strategy_draft, capital="1000"
    )
    with database() as db:
        migrate(db)
        ensure_account(db, owner)
        ensure_account(db, other)
        rejected = request.model_copy(update={"capital": Decimal("10001")})
        with pytest.raises(ValueError, match="exceeds the available paper capital"):
            start_draft_agent(db, owner, rejected)
        assert list_strategies(db, owner) == []
        assert list_agents(db, owner) == []

        set_emergency(db, owner, True)
        with pytest.raises(ValueError, match="cannot start agents"):
            start_draft_agent(db, owner, request)
        assert list_strategies(db, owner) == []
        set_emergency(db, owner, False)

        agent, strategy = start_draft_agent(db, owner, request)
        assert start_draft_agent(db, owner, request) == (agent, strategy)
        assert [entry["kind"] for entry in timeline(db, owner, agent)] == ["QUEUED"]
        [stored_agent] = list_agents(db, owner)
        assert stored_agent["stage"] == "VALIDATE"
        assert stored_agent["report_id"] is None
        assert stored_agent["strategy_id"] == strategy.id
        assert list_strategies(db, owner) == [strategy]
        assert get_strategy(db, other, strategy.id) is None
        assert timeline(db, other, agent) == []

        changed = request.model_copy(
            update={"document": strategy_draft.model_copy(update={"name": "Different rules"})}
        )
        with pytest.raises(ValueError, match="different strategy draft"):
            start_draft_agent(db, owner, changed)
        other_agent, other_strategy = start_draft_agent(db, other, request)
        assert other_agent != agent and other_strategy.id != strategy.id
        assert list_strategies(db, owner) == [strategy]
        assert list_strategies(db, other) == [other_strategy]


def test_activation_critic_rejects_unrealistic_holdout_before_trading():
    from backend.product.execution import PaperTerms
    from backend.product.workflow import activation_graph

    report = {
        "result": {
            "fixture": True,
            "assumptions": {"fee_bps": 0, "slippage_bps": 0},
            "in_sample": {"trade_count": 3},
            "out_of_sample": {
                "trade_count": 0,
                "maximum_drawdown": "0.20",
                "total_return": "-0.15",
                "benchmark_return": "0.01",
            },
        }
    }
    review = activation_graph().invoke(
        {"report": report, "terms": PaperTerms(), "allow_fixture": False}
    )
    assert len(review["reasons"]) == 4
    assert review["evidence"]["development_trades"] == 3
    assert review["evidence"]["holdout_trades"] == 0
    assert "independent evaluation window" in review["suggestion"]


def test_worker_backtests_saved_version_then_revalidates_on_independent_history(
    database, strategy_draft
):
    from datetime import timedelta

    from backend.models import now
    from backend.product.agents import AgentStart, claim_agent, list_agents, start_agent, timeline
    from backend.product.backtests import get_replay
    from backend.product.execution import order_history
    from backend.product.worker import PaperWorker
    from tests.e2e.product_api import history, quotes

    owner, other = uuid4(), uuid4()
    draft = strategy_draft.model_dump(mode="json")
    condition = {"indicator": "price", "operator": "gt", "threshold": "1"}
    for group in ("entry", "exit"):
        draft["definition"][group]["conditions"] = [condition]
    at = now() - timedelta(days=9)
    worker = PaperWorker(history, quotes, allow_fixture=True, clock=lambda: at)
    with database() as db:
        migrate(db)
        ensure_account(db, owner)
        ensure_account(db, other)
        strategy = create_strategy(db, owner, StrategyDraft.model_validate(draft))
        start = AgentStart(
            name="Automatic replay",
            strategy_id=strategy.id,
            strategy_version=strategy.version,
            epoch=1,
            capital="1000",
        )
        with pytest.raises(LookupError):
            start_agent(db, other, start)
        agent = start_agent(db, owner, start)
        initial = claim_agent(db)
        assert initial["report_id"] is None and initial["stage"] == "VALIDATE"
        worker.tick(db, initial)
        [running] = list_agents(db, owner)
        assert running["status"] == "RUNNING" and running["stage"] == "MONITOR"
        assert order_history(db, owner) == []
        assert start_agent(db, owner, start) == agent

        first_report = get_replay(db, owner, running["report_id"], include_dataset=True)
        assert first_report["market_data"]["candles"]
        assert get_replay(db, other, running["report_id"], include_dataset=False) is None

        at += timedelta(days=7)
        review = claim_agent(db)
        worker.tick(db, review)
        # Replaying the same leased job must not persist a second report.
        worker.tick(db, review)
        [reviewed] = list_agents(db, owner)
        assert reviewed["report_id"] != running["report_id"]
        second_report = get_replay(db, owner, reviewed["report_id"], include_dataset=False)
        assert first_report["request"]["end"] == second_report["request"]["start"]
        assert first_report["strategy_version"] == second_report["strategy_version"] == 1
        events = [e["detail"] for e in timeline(db, owner, agent) if e["kind"] == "REVALIDATION"]
        assert len(events) == 1 and events[0]["approved"]
        assert start_agent(db, owner, start) == agent
        assert order_history(db, owner) == []


def test_shared_paper_entry_frequency_counts_exits_without_blocking_exit(database):
    from datetime import timedelta

    from backend.models import now
    from backend.product.execution import REVIEWED_TRADE_CAPS as CAPS
    from backend.product.execution import OrderRequest, PaperQuote, PaperTerms, submit_order

    owner = uuid4()
    at = now().replace(hour=12, minute=0, second=0, microsecond=0)

    def submit(db, side, offset_seconds):
        instant = at + timedelta(seconds=offset_seconds)
        quote = PaperQuote(asset="BTC", price="50000", observed_at=instant, source="fixture")
        order = OrderRequest(request_key=uuid4(), epoch=1, asset="BTC", side=side, quantity="0.001")
        return submit_order(db, owner, order, {"BTC": quote}, PaperTerms(), clock=lambda: instant)

    with database() as db:
        migrate(db)
        ensure_account(db, owner)
        assert submit(db, "BUY", 0)["status"] == "FILLED"
        assert submit(db, "SELL", 1)["status"] == "FILLED"
        assert submit(db, "BUY", 60)["reason"] == "FREQUENCY"
        for index in range(2, CAPS["max_trades_per_hour"], 2):
            minute = index * 60
            assert submit(db, "BUY", minute)["status"] == "FILLED"
            assert submit(db, "SELL", minute + 1)["status"] == "FILLED"
        assert submit(db, "BUY", 8 * 60)["reason"] == "FREQUENCY"
        # Repeat in separate hours until the daily cap independently rejects a buy.
        completed_fills = CAPS["max_trades_per_hour"]
        n = 0
        while completed_fills < CAPS["max_trades_per_day"]:
            instant = (1 + n // 3) * 3600 + (n % 3) * 120
            assert submit(db, "BUY", instant)["status"] == "FILLED"
            assert submit(db, "SELL", instant + 1)["status"] == "FILLED"
            completed_fills += 2
            n += 1
        assert submit(db, "BUY", 6 * 3600)["reason"] == "FREQUENCY"


def test_self_hosted_accounts_are_unique_and_reserved_for_the_gateway(database_dsn, database):
    from uuid import UUID

    from backend.product.users import Credentials, Registration, authenticate, register

    with database() as db:
        migrate(db)
        user = register(
            db,
            Registration(email="Trader@Example.com", password="long password", display_name="Ana"),
        )
        assert user["email"] == "trader@example.com"
        with pytest.raises(ValueError, match="already exists"):
            register(
                db,
                Registration(email="trader@example.com", password="other pass", display_name="B"),
            )
        assert authenticate(db, Credentials(email="TRADER@example.com", password="long password"))
        assert authenticate(db, Credentials(email="trader@example.com", password="nope")) is None
        assert authenticate(db, Credentials(email="ghost@example.com", password="nope")) is None
        # A self-hosted user is a normal tenant: the paper account attaches to the same id.
        assert ensure_account(db, user["id"]).cash == Decimal("10000")

    key = "signed-product-test-material" * 2
    app = create_product_api(database_dsn, key, fixture_feeds=True)

    def headers(method, path, subject, body=""):
        expires = str(int(time.time()) + 20)
        checksum = hashlib.sha256(body.encode()).hexdigest()
        message = "\n".join([expires, str(subject), method, path, checksum])
        return {
            "x-krono-product-sub": str(subject),
            "x-krono-product-expires": expires,
            "x-krono-product-signature": hmac.new(
                key.encode(), message.encode(), hashlib.sha256
            ).hexdigest(),
            "content-type": "application/json",
        }

    login = json.dumps({"email": "trader@example.com", "password": "long password"})
    with TestClient(app) as client:
        path = "/platform/internal/sessions"
        tenant = client.post(path, headers=headers("POST", path, uuid4(), login), content=login)
        assert tenant.status_code == 403
        service = client.post(
            path, headers=headers("POST", path, UUID(int=0), login), content=login
        )
        assert service.status_code == 200
        assert service.json()["user"]["display_name"] == "Ana"


def test_leaderboard_ranks_every_tenant_by_return_without_exposing_other_ids(
    database, strategy_draft
):
    from backend.product.agents import DraftAgentStart, leaderboard, start_draft_agent
    from backend.product.users import Registration, register

    with database() as db:
        migrate(db)
        named = register(
            db, Registration(email="a@example.com", password="long password", display_name="Ana")
        )["id"]
        anonymous = uuid4()
        agents = {}
        for owner, name in ((named, "Steady"), (anonymous, "Volatile")):
            ensure_account(db, owner)
            request = DraftAgentStart(name=name, epoch=1, document=strategy_draft, capital="1000")
            agents[name], _ = start_draft_agent(db, owner, request)

        def mark(owner, agent, minutes_ago, equity):
            db.execute(
                """
                INSERT INTO paper_agent_equity VALUES
                (%s, %s, now() - make_interval(mins => %s), %s)
                """,
                (owner, agent, minutes_ago, equity),
            )

        mark(named, agents["Steady"], 10, "1020")
        mark(named, agents["Steady"], 5, "1050")
        mark(anonymous, agents["Volatile"], 10, "1200")
        mark(anonymous, agents["Volatile"], 5, "900")

        board = leaderboard(db, named)
        assert [row["name"] for row in board] == ["Steady", "Volatile"]
        steady, volatile = board
        assert steady["rank"] == 1 and steady["mine"] and steady["id"] == agents["Steady"]
        assert steady["owner"] == "Ana"
        assert steady["return_pct"] == Decimal("0.05")
        assert not volatile["mine"] and volatile["id"] is None
        assert volatile["owner"].startswith("Trader ")
        assert str(anonymous) not in json.dumps(board, default=str)
        assert volatile["return_pct"] == Decimal("-0.1")
        assert volatile["max_drawdown"] == Decimal("0.25")

        db.execute("UPDATE paper_agents SET status = 'STOPPED' WHERE id = %s", (agents["Steady"],))
        assert [row["name"] for row in leaderboard(db, named)] == ["Volatile"]
        assert len(leaderboard(db, named, "all")) == 2


class FakeExchange:
    """Exchange adapter double that records every call and fills at 50,000 USDT."""

    orders: dict = {}
    submitted: list = []
    cancelled: list = []
    fail_next_with = None

    @classmethod
    def reset(cls):
        cls.orders, cls.submitted, cls.cancelled, cls.fail_next_with = {}, [], [], None

    def __init__(self, exchange, environment, credentials):
        self.exchange, self.environment = exchange, environment
        self.key = credentials["api_key"]

    def close(self):
        pass

    def verify(self):
        if self.environment == "live" and self.key.startswith("WITHDRAW"):
            raise ValueError("This key can withdraw funds. Create a key with withdrawals disabled.")
        return {"can_trade": True, "withdrawals": False, "ip_restricted": True}

    def balances(self):
        return [
            {"asset": "USDT", "free": Decimal("900"), "locked": Decimal("0")},
            {"asset": "BTC", "free": Decimal("0.01"), "locked": Decimal("0")},
            {"asset": "DOGE", "free": Decimal("5"), "locked": Decimal("0")},
        ]

    def spot_assets(self, asset=None):
        return ["BTC", "ETH", "SOL", "ADA"]

    def market_order(self, asset, side, client_id, *, quote_amount=None, quantity=None):
        from backend.product.exchanges import result

        FakeExchange.submitted.append((client_id, side, quote_amount, quantity))
        executed = quantity if quantity is not None else quote_amount / 50000
        outcome = result("FILLED", len(FakeExchange.submitted), executed, executed * 50000)
        FakeExchange.orders[client_id] = outcome
        if FakeExchange.fail_next_with:
            error, FakeExchange.fail_next_with = FakeExchange.fail_next_with, None
            raise error
        return outcome

    def order(self, asset, client_id):
        from backend.product.exchanges import ExchangeError

        if client_id not in FakeExchange.orders:
            raise ExchangeError("Order does not exist", not_found=True)
        return FakeExchange.orders[client_id]

    def cancel_open_orders(self, asset):
        FakeExchange.cancelled.append(asset)
        return 0


def signed_client(database_dsn, key="signed-product-test-material" * 2, **options):
    from backend.product.credentials import CredentialVault

    app = create_product_api(
        database_dsn,
        key,
        fixture_feeds=True,
        credential_vault=CredentialVault(bytes(range(32))),
        live_client_factory=FakeExchange,
        **options,
    )

    def headers(method, path, subject, body=""):
        expires = str(int(time.time()) + 20)
        checksum = hashlib.sha256(body.encode()).hexdigest()
        message = "\n".join([expires, str(subject), method, path, checksum])
        return {
            "x-krono-product-sub": str(subject),
            "x-krono-product-expires": expires,
            "x-krono-product-signature": hmac.new(
                key.encode(), message.encode(), hashlib.sha256
            ).hexdigest(),
            "content-type": "application/json",
        }

    client = TestClient(app)

    def call(method, path, payload=None, subject=None):
        data = "" if payload is None else json.dumps(payload)
        return client.request(
            method, path, headers=headers(method, path, subject, data), content=data
        )

    return client, call


def test_ranked_strategy_copy_clones_profitable_version_for_the_viewer(
    database_dsn, database, strategy_draft
):
    from backend.models import now
    from backend.product.agents import DraftAgentStart, start_draft_agent
    from backend.product.execution import OrderRequest, PaperQuote, PaperTerms, submit_order

    owner, viewer = uuid4(), uuid4()
    draft = strategy_draft.model_copy(update={"description": "Private working notes"})
    with database() as db:
        migrate(db)
        ensure_account(db, owner)
        agent, _ = start_draft_agent(
            db,
            owner,
            DraftAgentStart(
                name="Winner",
                epoch=1,
                document=draft,
                capital="1000",
            ),
        )
        at = now()
        filled = submit_order(
            db,
            owner,
            OrderRequest(request_key=uuid4(), epoch=1, asset="BTC", side="BUY", quantity="0.0015"),
            {"BTC": PaperQuote(asset="BTC", price="50000", observed_at=at, source="fixture")},
            PaperTerms(),
            clock=lambda: at,
            agent_id=agent,
        )
        assert filled["status"] == "FILLED"
        db.execute(
            "INSERT INTO paper_agent_equity VALUES (%s, %s, %s, %s)", (owner, agent, at, 1050)
        )

    client, call = signed_client(database_dsn)
    with client:
        path = "/platform/ranked-strategies"
        rows = call("GET", path, subject=viewer).json()["items"]
        assert len(rows) == 1 and rows[0]["return_pct"] == "0.050000"
        assert str(agent) not in json.dumps(rows)
        assert "document" not in rows[0]
        response = call("POST", f"{path}/{rows[0]['share_id']}/copy", subject=viewer)
        assert response.status_code == 201, response.text
        copy = response.json()
        assert copy["version"] == 1
        assert copy["document"]["definition"] == draft.model_dump(mode="json")["definition"]
        assert copy["document"]["description"] == ""
        private_path = f"/platform/custom-strategies/{copy['id']}"
        assert call("GET", private_path, subject=viewer).status_code == 200
        assert call("GET", private_path, subject=owner).status_code == 404
        with database() as db:
            db.execute(
                "UPDATE platform_strategies SET archived_at = now() WHERE owner_id = %s", (owner,)
            )
        assert call("POST", f"{path}/{rows[0]['share_id']}/copy", subject=viewer).status_code == 404


def test_expanded_spot_markets_persist_paper_fills(database_dsn, database, strategy_draft):
    from backend.models import now
    from backend.product.execution import PaperQuote

    with database() as db:
        migrate(db)
    owner = uuid4()
    client, call = signed_client(
        database_dsn,
        quote_source=lambda assets: (
            {"ADA": PaperQuote(asset="ADA", price="0.60", observed_at=now(), source="fixture")}
            if "ADA" in assets
            else {}
        ),
    )
    with client:
        assert "ADA" in call("GET", "/platform/spot-markets", subject=owner).json()["assets"]
        assert (
            call("GET", "/platform/paper-market/ADA", subject=owner).json()["market"]["status"]
            == "FIXTURE"
        )
        assert call("POST", "/platform/paper-account", subject=owner).is_success
        payload = {
            "request_key": str(uuid4()),
            "epoch": 1,
            "asset": "ADA",
            "side": "BUY",
            "quantity": "100",
        }
        filled = call("POST", "/platform/paper-orders", payload, owner)
        assert filled.status_code == 201, filled.text
        assert filled.json()["status"] == "FILLED"
        payload.update(asset="UNLISTED", request_key=str(uuid4()))
        assert call("POST", "/platform/paper-orders", payload, owner).status_code == 422
        assert call("PUT", "/platform/paper-watchlist/ADA", {"enabled": True}, owner).is_success
        draft = strategy_draft.model_dump(mode="json")
        draft["definition"]["asset"] = "ADA"
        assert call("POST", "/platform/custom-strategies", draft, owner).status_code == 201


def test_live_trading_links_safe_keys_and_submits_each_order_once(database_dsn, database):
    from uuid import UUID

    from backend.product.exchanges import ExchangeError

    FakeExchange.reset()
    with database() as db:
        migrate(db)
    owner, other = uuid4(), uuid4()
    client, raw_call = signed_client(database_dsn)
    with client:

        def call(method, path, payload=None, subject=owner):
            return raw_call(method, path, payload, subject)

        base = "/platform/live/connections"
        unsafe = call(
            "POST",
            base,
            {
                "environment": "live",
                "label": "Main",
                "api_key": "WITHDRAW" + "a" * 20,
                "api_secret": "s" * 40,
            },
        )
        assert unsafe.status_code == 422
        assert "withdraw" in unsafe.json()["error"]["message"]

        linked = call(
            "POST",
            base,
            {
                "environment": "testnet",
                "label": "Testnet",
                "api_key": "K" * 60 + "WXYZ",
                "api_secret": "S" * 64,
                "max_order_usdt": "50",
            },
        )
        assert linked.status_code == 201, linked.text
        connection = linked.json()
        assert connection["key_hint"] == "…WXYZ" and "api_secret" not in linked.text
        with database() as db:
            (sealed,) = db.execute("SELECT ciphertext FROM live_connections").fetchone()
        assert b"SSSS" not in bytes(sealed)

        path = f"{base}/{connection['id']}"
        assert call("GET", f"{path}/account", subject=other).status_code == 404
        account = call("GET", f"{path}/account").json()
        assert account["total_value"] == "1400.00"
        assert account["complete"] is False
        assert [b["asset"] for b in account["balances"]][:2] == ["USDT", "BTC"]

        assert "ADA" in call("GET", f"{path}/spot-markets").json()["assets"]
        rejected = call(
            "POST",
            f"{path}/orders",
            {
                "request_key": str(uuid4()),
                "asset": "UNLISTED",
                "side": "BUY",
                "quote_amount": "10",
            },
        )
        assert rejected.json()["status"] == "REJECTED"
        assert not FakeExchange.submitted
        order = {"request_key": str(uuid4()), "asset": "ADA", "side": "BUY"}
        assert call("POST", f"{path}/orders", order | {"quote_amount": "60"}).status_code == 422
        filled = call("POST", f"{path}/orders", order | {"quote_amount": "40"})
        assert filled.status_code == 201, filled.text
        assert filled.json()["status"] == "FILLED"
        assert filled.json()["average_price"] == "50000.00000000"
        again = call("POST", f"{path}/orders", order | {"quote_amount": "40"})
        assert again.json()["id"] == filled.json()["id"]
        assert len(FakeExchange.submitted) == 1
        assert FakeExchange.submitted[0][0] == "kr-" + UUID(order["request_key"]).hex
        conflict = call("POST", f"{path}/orders", order | {"quote_amount": "41"})
        assert conflict.status_code == 422

        FakeExchange.fail_next_with = ExchangeError("timeout", unknown_outcome=True)
        uncertain = call(
            "POST",
            f"{path}/orders",
            {"request_key": str(uuid4()), "asset": "ETH", "side": "BUY", "quote_amount": "10"},
        )
        assert uncertain.json()["status"] == "FILLED"
        assert len(FakeExchange.submitted) == 2

        paused = call("POST", f"{path}/control", {"action": "pause"}).json()
        assert paused["status"] == "PAUSED"
        assert FakeExchange.cancelled == ["BTC", "ETH", "SOL"]
        blocked = call(
            "POST",
            f"{path}/orders",
            {"request_key": str(uuid4()), "asset": "SOL", "side": "BUY", "quote_amount": "5"},
        )
        assert blocked.status_code == 422 and "paused" in blocked.json()["error"]["message"]
        assert call("POST", f"{path}/control", {"action": "resume"}).json()["status"] == "ACTIVE"
        assert len(call("GET", f"{path}/orders").json()["items"]) == 3

        assert call("DELETE", path).status_code == 204
        assert call("GET", base).json()["items"] == []
        with database() as db:
            assert db.execute("SELECT ciphertext, status FROM live_connections").fetchone() == (
                None,
                "REVOKED",
            )


def test_promoted_agents_mirror_each_paper_fill_to_the_exchange_once(
    database_dsn, database, strategy_draft
):
    from backend.models import now
    from backend.product.agents import DraftAgentStart, list_agents, start_draft_agent, timeline
    from backend.product.backtests import save_replay
    from backend.product.credentials import CredentialVault
    from backend.product.execution import OrderRequest, PaperQuote, PaperTerms, submit_order
    from backend.product.history import HistoricalBacktestRequest
    from backend.product.live import mirror_fills

    FakeExchange.reset()
    vault = CredentialVault(bytes(range(32)))
    owner = uuid4()
    with database() as db:
        migrate(db)
        ensure_account(db, owner)
        agent, strategy = start_draft_agent(
            db,
            owner,
            DraftAgentStart(name="Mirror", epoch=1, document=strategy_draft, capital="1000"),
        )
        market = fixture_market("BTC")
        report = save_replay(
            db,
            owner,
            strategy,
            HistoricalBacktestRequest(
                version=1, start=market.candles[81].timestamp, end=market.candles[-1].closed_at
            ),
            market,
        )
    client, raw_call = signed_client(database_dsn)
    with client:

        def call(method, path, payload=None):
            return raw_call(method, path, payload, owner)

        connections = "/platform/live/connections"
        testnet = call(
            "POST",
            connections,
            {"label": "Test", "api_key": "T" * 20, "api_secret": "S" * 20, "max_order_usdt": "500"},
        ).json()
        live = call(
            "POST",
            connections,
            {"environment": "live", "label": "Real", "api_key": "R" * 20, "api_secret": "S" * 20},
        ).json()
        promote = f"/platform/paper-agents/{agent}/live"
        not_ready = call("POST", promote, {"connection_id": testnet["id"], "budget_usdt": "100"})
        assert not_ready.status_code == 422 and "passed validation" in not_ready.text
        with database() as db:
            db.execute(
                "UPDATE paper_agents SET stage = 'MONITOR', report_id = %s WHERE id = %s",
                (report["id"], agent),
            )
        too_new = call(
            "POST",
            promote,
            {"connection_id": live["id"], "budget_usdt": "100", "acknowledge_live": True},
        )
        assert too_new.status_code == 422 and "days of paper trading" in too_new.text
        promoted = call("POST", promote, {"connection_id": testnet["id"], "budget_usdt": "100"})
        assert promoted.status_code == 200, promoted.text

        def fill(side, quantity, price="50000"):
            with database() as db:
                quote = PaperQuote(asset="BTC", price=price, observed_at=now(), source="fixture")
                return submit_order(
                    db,
                    owner,
                    OrderRequest(
                        request_key=uuid4(), epoch=1, asset="BTC", side=side, quantity=quantity
                    ),
                    {"BTC": quote},
                    PaperTerms(),
                    agent_id=agent,
                )

        bought_paper = fill("BUY", "0.0015")  # 75 USDT of 1,000 paper capital
        assert bought_paper["status"] == "FILLED", bought_paper["reason"]
        with database() as db:
            assert mirror_fills(db, vault, FakeExchange) == 1
            assert mirror_fills(db, vault, FakeExchange) == 0  # each fill is mirrored once
        client_id, side, quote_amount, quantity = FakeExchange.submitted[0]
        assert side == "BUY" and quantity is None
        assert Decimal("7.4") < quote_amount <= Decimal("7.51")  # 75 x 100/1000, with costs

        assert fill("SELL", "0.00075")["status"] == "FILLED"  # half the paper position
        with database() as db:
            assert mirror_fills(db, vault, FakeExchange) == 1
        _, side, _, quantity = FakeExchange.submitted[1]
        bought = quote_amount / 50000
        assert side == "SELL" and abs(quantity - bought / 2) < Decimal("0.0000001")

        call("POST", f"{connections}/{testnet['id']}/control", {"action": "pause"})
        fill("SELL", "0.0005")
        with database() as db:
            assert mirror_fills(db, vault, FakeExchange) == 0
            kinds = [entry["kind"] for entry in timeline(db, owner, agent)]
        assert len(FakeExchange.submitted) == 2
        assert "LIVE_SKIPPED" in kinds and kinds.count("LIVE_ORDER") == 2
        call("POST", f"{connections}/{testnet['id']}/control", {"action": "resume"})

        orders = call("GET", f"/platform/paper-agents/{agent}/live/orders").json()["items"]
        assert [o["status"] for o in orders] == ["SKIPPED", "FILLED", "FILLED"]
        with database() as db:
            [listed] = list_agents(db, owner)
        assert listed["live_label"] == "Test" and listed["live_orders"] == 2

        stopped = call("POST", f"{promote}/stop", {"close_position": True}).json()
        assert stopped["live"] is False
        assert stopped["close_order"]["side"] == "SELL"
        assert Decimal(stopped["close_order"]["quantity"]) == bought - quantity
        with database() as db:
            [listed] = list_agents(db, owner)
        assert listed["live_connection_id"] is None
