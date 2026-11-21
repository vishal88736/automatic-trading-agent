"""Encryption for exchange API secrets at rest.

Secrets are sealed with AES-256-GCM under KRONO_CREDENTIAL_KEY (32 bytes, hex). The owner and
connection IDs are authenticated data, so a ciphertext copied to another row or tenant fails
to decrypt. In production, keep the key in a secret manager (for example AWS Secrets Manager
or a KMS-wrapped data key), never in the database.
"""

from __future__ import annotations

import json
import os
import secrets
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEY_ENV = "KRONO_CREDENTIAL_KEY"


class CredentialVault:
    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("The credential key must be 32 bytes")
        self._aead = AESGCM(key)

    @classmethod
    def from_environment(cls) -> CredentialVault | None:
        raw = os.environ.get(KEY_ENV, "")
        if not raw:
            return None
        try:
            return cls(bytes.fromhex(raw))
        except ValueError as exc:
            raise ValueError(f"{KEY_ENV} must be 64 hexadecimal characters") from exc

    @staticmethod
    def _context(owner: UUID, connection: UUID) -> bytes:
        return f"krono-live-credential:{owner}:{connection}".encode()

    def seal(self, owner: UUID, connection: UUID, secret: dict) -> tuple[bytes, bytes]:
        nonce = secrets.token_bytes(12)
        payload = json.dumps(secret, separators=(",", ":")).encode()
        return nonce, self._aead.encrypt(nonce, payload, self._context(owner, connection))

    def open(self, owner: UUID, connection: UUID, nonce: bytes, ciphertext: bytes) -> dict:
        try:
            plain = self._aead.decrypt(nonce, ciphertext, self._context(owner, connection))
        except InvalidTag as exc:
            raise ValueError("Stored credentials cannot be decrypted") from exc
        return json.loads(plain)
