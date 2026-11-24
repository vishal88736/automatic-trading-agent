"""Self-hosted accounts for deployments that do not use Cognito.

Passwords are stored as salted scrypt digests. The gateway issues the session cookie; this
module only creates accounts and verifies credentials.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Annotated
from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.errors import UniqueViolation
from pydantic import Field, StringConstraints

from backend.models import Model
from backend.product.errors import ConflictError

SCRYPT = {"n": 2**14, "r": 8, "p": 1}
Email = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$"),
]
DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class Registration(Model):
    email: Email
    password: str = Field(min_length=8, max_length=128)
    display_name: DisplayName


class Credentials(Model):
    email: Email
    password: str = Field(min_length=1, max_length=128)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        candidate = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt), dklen=32, n=int(n), r=int(r), p=int(p)
        )
    except ValueError:
        return False
    return hmac.compare_digest(candidate.hex(), digest)


# Compared against when the email is unknown, so both paths cost one scrypt evaluation.
_DUMMY_HASH = hash_password(secrets.token_hex(16))


def _public(row) -> dict:
    return {"id": row[0], "email": row[1], "display_name": row[2]}


def register(db: Connection, request: Registration) -> dict:
    user_id = uuid4()
    try:
        with db.transaction():
            db.execute("INSERT INTO platform_users (id) VALUES (%s)", (user_id,))
            row = db.execute(
                """
                INSERT INTO platform_credentials (user_id, email, display_name, password_hash)
                VALUES (%s, %s, %s, %s) RETURNING user_id, email, display_name
                """,
                (
                    user_id,
                    request.email.lower(),
                    request.display_name,
                    hash_password(request.password),
                ),
            ).fetchone()
    except UniqueViolation:
        raise ConflictError("An account with this email already exists") from None
    return _public(row)


def authenticate(db: Connection, credentials: Credentials) -> dict | None:
    row = db.execute(
        "SELECT user_id, email, display_name, password_hash FROM platform_credentials WHERE email = %s",
        (credentials.email.lower(),),
    ).fetchone()
    if row is None:
        verify_password(credentials.password, _DUMMY_HASH)
        return None
    return _public(row) if verify_password(credentials.password, row[3]) else None


def get_user(db: Connection, user_id: UUID) -> dict | None:
    row = db.execute(
        "SELECT user_id, email, display_name FROM platform_credentials WHERE user_id = %s",
        (user_id,),
    ).fetchone()
    return _public(row) if row else None
