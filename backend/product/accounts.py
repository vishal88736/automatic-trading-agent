"""Provision and read paper accounts for a verified Cognito subject."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID, uuid4

from psycopg import Connection

from backend.product.errors import ConflictError

DEFAULT_INITIAL_USDT = Decimal("10000")


@dataclass(frozen=True)
class PaperAccount:
    id: UUID
    epoch: int
    currency: str
    cash: Decimal


def get_account(db: Connection, owner_id: UUID) -> PaperAccount | None:
    row = db.execute(
        """
        SELECT account.id, epoch.epoch, account.currency, SUM(entry.amount)
        FROM paper_accounts AS account
        JOIN paper_account_epochs AS epoch
          ON (account.owner_id, account.id) = (epoch.owner_id, epoch.account_id)
        JOIN paper_ledger_entries AS entry
          ON (epoch.owner_id, epoch.account_id, epoch.epoch) =
             (entry.owner_id, entry.account_id, entry.epoch)
        WHERE account.owner_id = %s AND epoch.closed_at IS NULL
        GROUP BY account.id, epoch.epoch
        """,
        (owner_id,),
    ).fetchone()
    return PaperAccount(*row) if row else None


def ensure_account(
    db: Connection, owner_id: UUID, initial_usdt: Decimal = DEFAULT_INITIAL_USDT
) -> PaperAccount:
    """Create the first account epoch and credit together, once per owner."""
    if not isinstance(initial_usdt, Decimal):
        raise TypeError("The opening credit must be provided as a Decimal")
    with db.transaction():
        db.execute(
            "INSERT INTO platform_users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING",
            (owner_id,),
        )
        created = db.execute(
            """
            INSERT INTO paper_accounts (owner_id, id) VALUES (%s, %s)
            ON CONFLICT (owner_id) DO NOTHING
            RETURNING id
            """,
            (owner_id, uuid4()),
        ).fetchone()
        if created:
            account_id = created[0]
            db.execute(
                "INSERT INTO paper_account_epochs (owner_id, account_id, epoch) VALUES (%s, %s, 1)",
                (owner_id, account_id),
            )
            db.execute(
                """
                INSERT INTO paper_ledger_entries (owner_id, account_id, epoch, kind, amount)
                VALUES (%s, %s, 1, 'OPENING_CREDIT', %s)
                """,
                (owner_id, account_id, initial_usdt),
            )
        account = get_account(db, owner_id)
        if account is None:
            raise ConflictError("Paper account has no funded open epoch")
    return account
