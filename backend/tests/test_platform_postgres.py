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
from backend.paper_accounts import ensure_account, get_account  # noqa: E402
from backend.platform_db import MIGRATIONS, migrate, open_database  # noqa: E402
from backend.platform_product_api import create_product_api  # noqa: E402
from backend.strategy_repository import (  # noqa: E402
    archive_strategy,
    create_strategy,
    get_strategy,
    list_strategies,
    strategy_history,
    update_strategy,
)
from backend.strategy_rules import StrategyDraft  # noqa: E402


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
    from backend.paper_execution import (
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


def test_parallel_submissions_share_cash_lock(database):
    from backend.models import now
    from backend.paper_execution import OrderRequest, PaperQuote, PaperTerms, submit_order

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

    from backend.backtest_repository import save_replay
    from backend.historical_data import HistoricalBacktestRequest
    from backend.models import now
    from backend.paper_agents import (
        AgentStart,
        claim_agent,
        close_agent_position,
        control_agent,
        list_agents,
        start_agent,
        timeline,
    )
    from backend.paper_execution import (
        OrderRequest,
        PaperTerms,
        order_history,
        positions,
        submit_order,
    )
    from backend.paper_worker import PaperWorker
    from e2e.product_api import history, quotes

    owner, other = uuid4(), uuid4()
    raw = strategy_draft.model_dump(mode="json")
    raw["definition"]["entry"]["conditions"] = [
        {"indicator": "price", "operator": "gt", "threshold": "1"}
    ]
    raw["definition"]["exit"]["conditions"] = [
        {"indicator": "price", "operator": "gt", "threshold": "1"}
    ]
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
        from backend.paper_execution import PaperQuote

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


def test_activation_critic_rejects_unrealistic_holdout_before_trading():
    from backend.paper_execution import PaperTerms
    from backend.paper_workflow import activation_graph

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

    from backend.backtest_repository import get_replay
    from backend.models import now
    from backend.paper_agents import AgentStart, claim_agent, list_agents, start_agent, timeline
    from backend.paper_execution import order_history
    from backend.paper_worker import PaperWorker
    from e2e.product_api import history, quotes

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

    from aegis.risk.policy import CAPS
    from backend.models import now
    from backend.paper_execution import OrderRequest, PaperQuote, PaperTerms, submit_order

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
