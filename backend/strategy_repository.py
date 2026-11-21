"""Owner-scoped strategy storage with optimistic checks and immutable versions."""

from __future__ import annotations

from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb
from pydantic import AwareDatetime

from backend.models import Model
from backend.strategy_rules import StrategyDraft


class StoredStrategy(Model):
    id: UUID
    version: int
    document: StrategyDraft
    created_at: AwareDatetime


def _stored(row) -> StoredStrategy:
    return StoredStrategy(id=row[0], version=row[1], document=row[2], created_at=row[3])


def _insert_version(
    db: Connection, owner_id: UUID, strategy_id: UUID, version: int, draft: StrategyDraft
) -> StoredStrategy:
    row = db.execute(
        """
        INSERT INTO platform_strategy_versions (owner_id, strategy_id, version, document)
        VALUES (%s, %s, %s, %s)
        RETURNING strategy_id, version, document, created_at
        """,
        (owner_id, strategy_id, version, Jsonb(draft.model_dump(mode="json"))),
    ).fetchone()
    return _stored(row)


def create_strategy(
    db: Connection, owner_id: UUID, draft: StrategyDraft, *, strategy_id: UUID | None = None
) -> StoredStrategy:
    strategy_id = strategy_id or uuid4()
    with db.transaction():
        db.execute(
            "INSERT INTO platform_strategies (owner_id, id) VALUES (%s, %s)",
            (owner_id, strategy_id),
        )
        return _insert_version(db, owner_id, strategy_id, 1, draft)


def get_strategy(
    db: Connection, owner_id: UUID, strategy_id: UUID, version: int | None = None
) -> StoredStrategy | None:
    row = db.execute(
        """
        SELECT version.strategy_id, version.version, version.document, version.created_at
        FROM platform_strategy_versions AS version
        JOIN platform_strategies AS strategy
          ON (strategy.owner_id, strategy.id) = (version.owner_id, version.strategy_id)
        WHERE version.owner_id = %s AND version.strategy_id = %s
          AND (version.version = %s OR (%s::integer IS NULL AND strategy.archived_at IS NULL))
        ORDER BY version.version DESC
        LIMIT 1
        """,
        (owner_id, strategy_id, version, version),
    ).fetchone()
    return _stored(row) if row else None


def list_strategies(
    db: Connection, owner_id: UUID, *, after: UUID | None = None, limit: int = 50
) -> list[StoredStrategy]:
    if not 1 <= limit <= 100:
        raise ValueError("Strategy limit must be between 1 and 100")
    rows = db.execute(
        """
        SELECT current.strategy_id, current.version, current.document, current.created_at
        FROM platform_strategies AS strategy
        CROSS JOIN LATERAL (
            SELECT strategy_id, version, document, created_at
            FROM platform_strategy_versions
            WHERE owner_id = strategy.owner_id AND strategy_id = strategy.id
            ORDER BY version DESC
            LIMIT 1
        ) AS current
        WHERE strategy.owner_id = %s AND strategy.archived_at IS NULL
          AND (%s::uuid IS NULL OR strategy.id > %s)
        ORDER BY strategy.id
        LIMIT %s
        """,
        (owner_id, after, after, limit),
    )
    return [_stored(row) for row in rows]


def strategy_history(
    db: Connection,
    owner_id: UUID,
    strategy_id: UUID,
    *,
    before_version: int = 2**31,
    limit: int = 50,
) -> list[StoredStrategy]:
    if not 1 <= limit <= 100:
        raise ValueError("History limit must be between 1 and 100")
    rows = db.execute(
        """
        SELECT strategy_id, version, document, created_at
        FROM platform_strategy_versions
        WHERE owner_id = %s AND strategy_id = %s AND version < %s
        ORDER BY version DESC
        LIMIT %s
        """,
        (owner_id, strategy_id, before_version, limit),
    )
    return [_stored(row) for row in rows]


def _lock_current(
    db: Connection, owner_id: UUID, strategy_id: UUID, expected_version: int
) -> StoredStrategy:
    row = db.execute(
        """
        SELECT id FROM platform_strategies
        WHERE owner_id = %s AND id = %s AND archived_at IS NULL
        FOR UPDATE
        """,
        (owner_id, strategy_id),
    ).fetchone()
    if not row:
        raise LookupError("Strategy is unavailable")
    current = get_strategy(db, owner_id, strategy_id)
    if current is None or current.version != expected_version:
        raise ValueError("Strategy version changed")
    return current


def update_strategy(
    db: Connection,
    owner_id: UUID,
    strategy_id: UUID,
    draft: StrategyDraft,
    *,
    expected_version: int,
) -> StoredStrategy:
    with db.transaction():
        current = _lock_current(db, owner_id, strategy_id, expected_version)
        if current.document == draft:
            return current
        return _insert_version(db, owner_id, strategy_id, current.version + 1, draft)


def archive_strategy(
    db: Connection, owner_id: UUID, strategy_id: UUID, *, expected_version: int
) -> None:
    with db.transaction():
        _lock_current(db, owner_id, strategy_id, expected_version)
        db.execute(
            """
            UPDATE platform_strategies SET archived_at = now()
            WHERE owner_id = %s AND id = %s
            """,
            (owner_id, strategy_id),
        )
