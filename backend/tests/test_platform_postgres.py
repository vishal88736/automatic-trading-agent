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
