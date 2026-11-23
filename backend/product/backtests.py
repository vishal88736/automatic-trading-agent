"""Persist immutable, owner-scoped replay reports and historical inputs."""

from __future__ import annotations

import hashlib
import json
from datetime import timezone
from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.backtesting import RULE_WARMUP_HOURS, backtest_rules
from backend.models import Market
from backend.product.history import HOUR, HistoricalBacktestRequest
from backend.product.strategies import StoredStrategy

REPLAY_VERSION = "krono-spot-hourly-v2"


def save_replay(
    db: Connection,
    owner_id: UUID,
    strategy: StoredStrategy,
    request: HistoricalBacktestRequest,
    market: Market,
) -> dict:
    start = request.start.astimezone(timezone.utc) - RULE_WARMUP_HOURS * HOUR
    end = request.end.astimezone(timezone.utc)
    if (
        not market.candles
        or market.candles[0].timestamp != start
        or market.candles[-1].closed_at != end
    ):
        raise ValueError("Dataset does not match the requested replay window")
    result = backtest_rules(market, request, strategy.document.definition, request.risk)
    market_data = market.model_dump(mode="json")
    dataset_key = {key: market_data[key] for key in ("asset", "timeframe", "source", "candles")}
    checksum = hashlib.sha256(
        json.dumps(dataset_key, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    run_id = uuid4()
    metadata = {
        "id": str(run_id),
        "strategy_id": str(strategy.id),
        "strategy_version": strategy.version,
        "engine_version": REPLAY_VERSION,
        "dataset": {
            "sha256": checksum,
            "source": market.source,
            "venue": market.venue,
            "product_id": market.product_id,
            "quote_currency": market.quote_currency,
            "evaluation_start_utc": request.start.astimezone(timezone.utc).isoformat(),
            "evaluation_end_utc": end.isoformat(),
            "evaluation_candle_count": len(market.candles) - RULE_WARMUP_HOURS,
            "timeframe": market.timeframe,
            "as_of": market_data["as_of"],
            "retrieved_at": market_data["retrieved_at"],
            "candle_count": len(market.candles),
            "warmup_hours": RULE_WARMUP_HOURS,
        },
        "request": request.model_dump(mode="json"),
        "result": result,
    }
    db.execute(
        """
        INSERT INTO platform_backtests (owner_id, id, strategy_id, strategy_version, dataset, report)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (owner_id, run_id, strategy.id, strategy.version, Jsonb(market_data), Jsonb(metadata)),
    )
    return metadata


def get_replay(
    db: Connection, owner_id: UUID, run_id: UUID, *, include_dataset: bool
) -> dict | None:
    row = db.execute(
        """
        SELECT report, CASE WHEN %s THEN dataset ELSE NULL END
        FROM platform_backtests WHERE owner_id = %s AND id = %s
        """,
        (include_dataset, owner_id, run_id),
    ).fetchone()
    if not row:
        return None
    report, dataset = row
    return {**report, "market_data": dataset} if include_dataset else report
