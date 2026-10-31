"""Validated operator defaults. Secrets and mandatory safeguards never come from this file."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

ROOT = Path(__file__).resolve().parents[1]


class SettingsModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)


def public_https(value: str) -> str:
    parts = urlsplit(value)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or parts.hostname.lower() == "localhost"
        or parts.port not in {None, 443}
    ):
        raise ValueError("Configure a public HTTPS endpoint without credentials, query or fragment")
    try:
        address = ipaddress.ip_address(parts.hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise ValueError("Private network endpoints are not allowed")
    return value.rstrip("/")


Endpoint = Annotated[str, AfterValidator(public_https)]
Amount = Annotated[Decimal, Field(ge=0, max_digits=38, decimal_places=18)]


class ProviderRefresh(SettingsModel):
    ticker_seconds: int = Field(default=5, ge=1, le=60)
    candles_seconds: int = Field(default=300, ge=60, le=3600)
    news_seconds: int = Field(default=60, ge=15, le=900)
    failure_retry_seconds: int = Field(default=15, ge=5, le=300)


class ReferenceAsset(SettingsModel):
    name: str = Field(min_length=1, max_length=80)
    product_id: str = Field(pattern=r"^[A-Z0-9]{2,20}-USD$")


class DataSettings(SettingsModel):
    market: Literal["fixture", "coinbase"]
    news: Literal["fixture", "cryptocurrency.cv"]
    market_base_url: Endpoint
    news_base_url: Endpoint
    timeout_seconds: int = Field(ge=1, le=30)
    connect_timeout_seconds: int = Field(ge=1, le=10)
    max_connections: int = Field(ge=1, le=20)
    concurrency: int = Field(ge=1, le=10)
    read_attempts: int = Field(ge=1, le=3)
    retry_delay_seconds: float = Field(ge=0.1, le=2)
    refresh: ProviderRefresh
    assets: dict[str, ReferenceAsset]

    @model_validator(mode="after")
    def supported_identity(self):
        # New assets require a reviewed adapter/schema addition, never a symbol alias.
        if not self.assets or not self.assets.keys() <= {"BTC", "ETH", "SOL"}:
            raise ValueError("Only registered reference assets are supported")
        if any(a.product_id != f"{symbol}-USD" for symbol, a in self.assets.items()):
            raise ValueError("Reference product identity must match its asset")
        return self


class SimulationSettings(SettingsModel):
    initial_equity: Amount = Field(gt=0, le=100000000)
    fee_bps: int = Field(ge=0, le=100)
    slippage_bps: int = Field(ge=0, le=100)
    liquidity_usd: Amount = Field(gt=0)
    network_fee_usd: Amount = Field(le=10)
    quote_ttl_seconds: int = Field(ge=5, le=60)
    deadline_seconds: int = Field(ge=5, le=120)
    proposal_ttl_seconds: int = Field(ge=30, le=300)
    mark_snapshot_seconds: int = Field(default=60, ge=5, le=3600)

    @model_validator(mode="after")
    def deadline_after_expiry(self):
        if self.deadline_seconds < self.quote_ttl_seconds:
            raise ValueError("Transaction deadline must not precede quote expiry")
        return self


class SchedulerSettings(SettingsModel):
    interval_seconds: int = Field(ge=30, le=86400)
    default_asset: str


class DocumentedToken(SettingsModel):
    address: str = Field(pattern=r"^0x[0-9a-fA-F]{40}$")
    name: str = Field(min_length=1, max_length=80)


class NetworkSettings(SettingsModel):
    chain_id: int = Field(gt=0)
    rpc_url: Endpoint
    explorer: Endpoint
    native_symbol: str = Field(pattern=r"^[A-Z0-9]{2,20}$")
    native_decimals: int = Field(ge=0, le=36)
    network_source: Endpoint
    token_source: Endpoint
    tokens: dict[str, DocumentedToken]


class RuntimeSettings(SettingsModel):
    schema_version: Literal[1]
    providers: DataSettings
    simulation: SimulationSettings
    scheduler: SchedulerSettings
    hsk: NetworkSettings

    @model_validator(mode="after")
    def default_asset_available(self):
        if self.scheduler.default_asset not in self.providers.assets:
            raise ValueError("Scheduler asset must exist in the configured reference universe")
        return self

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(
            json.dumps(self.model_dump(mode="json"), sort_keys=True).encode()
        ).hexdigest()


@lru_cache(maxsize=1)
def get_settings() -> RuntimeSettings:
    path = Path(os.getenv("KRONO_CONFIG_PATH", str(ROOT / "config/runtime.json")))
    if not path.is_absolute():
        path = ROOT / path
    try:
        return RuntimeSettings.model_validate_json(path.read_text())
    except (OSError, ValueError) as exc:
        raise ValueError(
            "Runtime configuration is missing or invalid; inspect config/runtime.json"
        ) from exc
