"""Configured spot tickers from Binance's public market-data stream.

One WebSocket connection (no API key) feeds every browser through the product API, with
REST polling as a fallback. The live trading dashboard values exchange balances with the
same prices.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import httpx
import websockets

from backend.settings import get_settings

log = logging.getLogger(__name__)

_providers = get_settings().providers
ASSETS = {asset: f"{asset}USDT" for asset in _providers.featured_assets}
SYMBOLS = {symbol: asset for asset, symbol in ASSETS.items()}
STREAM_URL = (
    _providers.spot_endpoints.ticker_stream
    + "?streams="
    + "/".join(f"{symbol.lower()}@miniTicker" for symbol in ASSETS.values())
)
REST_URL = _providers.spot_endpoints.ticker_rest
KLINES_URL = REST_URL.rsplit("/ticker/", 1)[0] + "/klines"
STALE_SECONDS = 90
HISTORY_HOURS = 24
HISTORY_REFRESH_SECONDS = 300


def _decimal(value) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("Invalid price") from exc
    if not parsed.is_finite():
        raise ValueError("Invalid price")
    return parsed


def quote(asset: str, last, open_, high, low, volume, at_ms) -> dict:
    price, opened = _decimal(last), _decimal(open_)
    if price <= 0:
        raise ValueError("Invalid price")
    return {
        "asset": asset,
        "symbol": ASSETS[asset],
        "price": price,
        "open_24h": opened,
        "high_24h": _decimal(high),
        "low_24h": _decimal(low),
        "volume_24h_usdt": _decimal(volume),
        "change_24h": round((price - opened) / opened, 6) if opened else None,
        "at": datetime.fromtimestamp(int(at_ms) / 1000, timezone.utc),
    }


class PriceHub:
    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        connect=websockets.connect,
        poll_seconds: float = 10,
        stream: bool = True,
    ):
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(10, connect=5),
            transport=transport,
            headers={"User-Agent": "Krono/0.1 (+price hub)"},
        )
        self.connect = connect
        self.poll_seconds = poll_seconds
        self.stream_enabled = stream
        self.prices: dict[str, dict] = {}
        # Hourly closes for the last day, so price sparklines show the real 24h trend.
        self.history: dict[str, list[Decimal]] = {}
        self._history_due = 0.0
        self.subscribers: set[asyncio.Queue] = set()
        self.connected = False
        self._tasks: list[asyncio.Task] = []

    async def start(self):
        self._tasks = [asyncio.create_task(self._poll_loop())]
        if self.stream_enabled:
            self._tasks.append(asyncio.create_task(self._stream_loop()))

    async def stop(self):
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.client.aclose()

    def snapshot(self) -> dict:
        fresh = {
            asset: item
            for asset, item in self.prices.items()
            if (datetime.now(timezone.utc) - item["at"]).total_seconds() < STALE_SECONDS
        }
        return {
            "source": "binance",
            "live": self.connected,
            "assets": list(ASSETS),
            "prices": fresh,
            "history": {asset: closes for asset, closes in self.history.items() if closes},
        }

    def price(self, asset: str) -> Decimal | None:
        item = self.snapshot()["prices"].get(asset)
        return item["price"] if item else None

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        self.subscribers.discard(queue)

    def update(self, item: dict):
        self.prices[item["asset"]] = item
        for queue in list(self.subscribers):
            if queue.full():
                # Prices supersede each other, so a slow client only needs the latest.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(item)

    def handle_message(self, raw: str | bytes):
        message = json.loads(raw)
        data = message.get("data", message)
        asset = SYMBOLS.get(data.get("s", ""))
        if asset and data.get("e") == "24hrMiniTicker":
            self.connected = True
            self.update(
                quote(asset, data["c"], data["o"], data["h"], data["l"], data["q"], data["E"])
            )

    async def refresh(self):
        response = await self.client.get(
            REST_URL, params={"symbols": json.dumps(list(ASSETS.values()), separators=(",", ":"))}
        )
        response.raise_for_status()
        for row in response.json():
            asset = SYMBOLS.get(row.get("symbol", ""))
            if asset:
                self.update(
                    quote(
                        asset,
                        row["lastPrice"],
                        row["openPrice"],
                        row["highPrice"],
                        row["lowPrice"],
                        row["quoteVolume"],
                        row["closeTime"],
                    )
                )

    async def refresh_history(self):
        history = {}
        for asset, symbol in ASSETS.items():
            response = await self.client.get(
                KLINES_URL, params={"symbol": symbol, "interval": "1h", "limit": HISTORY_HOURS}
            )
            response.raise_for_status()
            closes = [_decimal(row[4]) for row in response.json()]
            if closes and all(close > 0 for close in closes):
                history[asset] = closes
        self.history.update(history)

    async def _poll_loop(self):
        while True:
            if time.monotonic() >= self._history_due:
                try:
                    await self.refresh_history()
                    self._history_due = time.monotonic() + HISTORY_REFRESH_SECONDS
                except (httpx.HTTPError, ValueError, KeyError, TypeError, IndexError) as exc:
                    log.warning("Price history refresh failed: %s", type(exc).__name__)
                    self._history_due = time.monotonic() + 60
            if not self.connected or not self.prices:
                try:
                    await self.refresh()
                except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                    log.warning("Price refresh failed: %s", type(exc).__name__)
            await asyncio.sleep(self.poll_seconds)

    async def _stream_loop(self):
        delay = 2.0
        while True:
            started = time.monotonic()
            try:
                async with self.connect(STREAM_URL, ping_interval=20, open_timeout=10) as socket:
                    async for raw in socket:
                        try:
                            self.handle_message(raw)
                        except (ValueError, KeyError, TypeError):
                            continue
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as exc:
                log.info("Price stream reconnecting: %s", type(exc).__name__)
            finally:
                self.connected = False
            if time.monotonic() - started > 60:
                delay = 2.0
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)
