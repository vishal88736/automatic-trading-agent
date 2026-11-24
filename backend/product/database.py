"""PostgreSQL connection and forward migrations for tenant product state."""

from __future__ import annotations

import os
from hashlib import sha256
from pathlib import Path

from psycopg import Connection, connect
from psycopg.conninfo import make_conninfo
from psycopg_pool import ConnectionPool

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations" / "versions"
MIGRATION_LOCK = 0x4B524F4E4F
DSN_ENV = "KRONO_DATABASE_DSN"
CONNECTION_OPTIONS = {"connect_timeout": 5, "client_encoding": "UTF8", "autocommit": True}


def database_dsn() -> str:
    if dsn := os.environ.get(DSN_ENV):
        return dsn
    fields = {
        "host": os.environ.get("KRONO_DATABASE_HOST"),
        "dbname": os.environ.get("KRONO_DATABASE_NAME"),
        "user": os.environ.get("KRONO_DATABASE_USER"),
        "password": os.environ.get("KRONO_DATABASE_PASSWORD"),
    }
    if not all(fields.values()):
        raise ValueError(f"Set {DSN_ENV} or the platform database host, name, user and password")
    sslmode = os.environ.get("KRONO_DATABASE_SSLMODE", "verify-full")
    sslrootcert = os.environ.get("KRONO_DATABASE_SSLROOTCERT")
    if not sslrootcert and sslmode == "verify-full":
        sslrootcert = "system"
    return make_conninfo(
        **fields,
        port=os.environ.get("KRONO_DATABASE_PORT", "5432"),
        sslmode=sslmode,
        sslrootcert=sslrootcert,
    )


def open_database(dsn: str) -> Connection:
    return connect(dsn, **CONNECTION_OPTIONS)


def database_pool(dsn: str, *, max_size: int = 8) -> ConnectionPool:
    def configure(db: Connection):
        db.execute("SET statement_timeout = '5s'")

    return ConnectionPool(
        dsn,
        kwargs=CONNECTION_OPTIONS,
        min_size=0,
        max_size=max_size,
        timeout=5,
        configure=configure,
        check=ConnectionPool.check_connection,
        open=False,
    )


def migrate(db: Connection, directory: Path = MIGRATIONS) -> list[str]:
    """Apply an ordered migration set atomically and verify applied file digests."""
    files = sorted(directory.glob("*.sql"))
    if not files:
        raise ValueError("No platform database migrations found")
    migrations = [(path.stem, path.read_bytes()) for path in files]

    with db.transaction():
        db.execute("SET LOCAL lock_timeout = '10s'")
        db.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK,))
        db.execute("""
            CREATE TABLE IF NOT EXISTS platform_schema_migrations (
                revision TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        applied = db.execute(
            "SELECT revision, sha256 FROM platform_schema_migrations ORDER BY revision"
        ).fetchall()
        expected = [(revision, sha256(source).hexdigest()) for revision, source in migrations]
        if applied != expected[: len(applied)]:
            raise ValueError("Platform database migration history differs from the checkout")

        pending = []
        for (revision, source), (_, digest) in zip(
            migrations[len(applied) :], expected[len(applied) :], strict=True
        ):
            db.execute(source.decode("utf-8"), prepare=False)
            db.execute(
                "INSERT INTO platform_schema_migrations (revision, sha256) VALUES (%s, %s)",
                (revision, digest),
            )
            pending.append(revision)
    return pending
