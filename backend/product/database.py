"""PostgreSQL connection and forward migrations for tenant product state."""

from __future__ import annotations

from hashlib import sha256
from pathlib import Path

from psycopg import Connection, connect

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations" / "versions"
MIGRATION_LOCK = 0x4B524F4E4F
DSN_ENV = "KRONO_DATABASE_DSN"


def open_database(dsn: str) -> Connection:
    return connect(dsn, connect_timeout=5, client_encoding="UTF8", autocommit=True)


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
