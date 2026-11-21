"""Live crypto news from the hosted cryptocurrency.cv API, shared by every browser.

One server-side connection to the provider's Server-Sent Events stream feeds a rolling,
de-duplicated buffer. REST polling fills the buffer at startup and whenever the stream is
down. Browsers subscribe to the hub through the product API, so the provider sees a single
client no matter how many users are reading.

The hosted API is free and keyless: https://github.com/nirholas/cryptocurrency.cv
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import OrderedDict
from datetime import datetime, timezone

import httpx

from backend.data import normalize_news
from backend.models import Article, NewsScoring, now

log = logging.getLogger(__name__)

TRACKED_ASSETS = ("BTC", "ETH", "SOL")


class NewsHub:
    def __init__(
        self,
        base_url: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        poll_seconds: float = 60,
        pulse_seconds: float = 300,
        buffer: int = 300,
        stream: bool = True,
    ):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(15, connect=6, read=75),
            transport=transport,
            follow_redirects=False,
            headers={"User-Agent": "Krono/0.1 (+news hub)"},
        )
        self.poll_seconds = poll_seconds
        self.pulse_seconds = pulse_seconds
        self.buffer = buffer
        self.stream_enabled = stream
        self.scoring = NewsScoring()
        self.articles: OrderedDict[str, Article] = OrderedDict()
        self.subscribers: set[asyncio.Queue] = set()
        self.connected = False
        self.last_update: datetime | None = None
        self.last_error: str | None = None
        self._pulse: tuple[float, dict] | None = None
        self._pulse_lock = asyncio.Lock()
        self._tasks: list[asyncio.Task] = []

    # ---------- lifecycle ----------
    async def start(self):
        self._tasks = [asyncio.create_task(self._poll_loop())]
        if self.stream_enabled:
            self._tasks.append(asyncio.create_task(self._stream_loop()))

    async def stop(self):
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.client.aclose()

    # ---------- reading ----------
    def snapshot(self, asset: str | None = None, limit: int = 100) -> list[Article]:
        items = sorted(
            self.articles.values(),
            key=lambda a: a.published_at or a.available_at,
            reverse=True,
        )
        if asset:
            items = [a for a in items if asset in a.assets]
        return items[:limit]

    def status(self) -> dict:
        return {
            "source": "cryptocurrency.cv",
            "live": self.connected,
            "articles": len(self.articles),
            "updated_at": self.last_update,
            "error": self.last_error if not self.articles else None,
        }

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        self.subscribers.discard(queue)

    # ---------- ingest ----------
    def ingest(self, payload: dict, *, breaking: bool = False) -> list[Article]:
        """Normalize a provider payload, keep unseen articles and notify subscribers."""
        retrieved = now()
        fresh = []
        for article in normalize_news(payload, retrieved, breaking, self.scoring):
            known = self.articles.get(article.id)
            if known:
                if breaking and known.urgency != "breaking":
                    self.articles[article.id] = known.model_copy(update={"urgency": "breaking"})
                continue
            self.articles[article.id] = article
            fresh.append(article)
        while len(self.articles) > self.buffer:
            oldest = min(self.articles.values(), key=lambda a: a.published_at or a.available_at)
            del self.articles[oldest.id]
        if fresh:
            self.last_update = retrieved
            for queue in list(self.subscribers):
                for article in reversed(fresh):
                    try:
                        queue.put_nowait(article)
                    except asyncio.QueueFull:
                        # A stalled client misses articles but can reload the snapshot.
                        break
        return fresh

    async def refresh(self):
        for path, breaking in (("/api/news?limit=100", False), ("/api/breaking", True)):
            response = await self.client.get(self.base_url + path)
            response.raise_for_status()
            self.ingest(response.json(), breaking=breaking)
        self.last_error = None

    async def _poll_loop(self):
        while True:
            try:
                await self.refresh()
            except (httpx.HTTPError, ValueError) as exc:
                self.last_error = f"News provider unavailable ({type(exc).__name__})"
                log.warning("News refresh failed: %s", type(exc).__name__)
            # Poll slowly while the live stream delivers; quickly when it is down.
            await asyncio.sleep(self.poll_seconds * (5 if self.connected else 1))

    async def _stream_loop(self):
        delay = 2.0
        while True:
            try:
                async with self.client.stream(
                    "GET",
                    self.base_url + "/api/sse",
                    params={"breaking": "true"},
                    headers={"Accept": "text/event-stream"},
                ) as response:
                    response.raise_for_status()
                    delay = 2.0
                    await self._consume(response)
            except (httpx.HTTPError, ValueError) as exc:
                log.info("News stream reconnecting: %s", type(exc).__name__)
            finally:
                self.connected = False
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    async def _consume(self, response: httpx.Response):
        event, data = "message", []
        async for line in response.aiter_lines():
            if line == "":
                if data:
                    self._dispatch(event, "\n".join(data))
                event, data = "message", []
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())

    def _dispatch(self, event: str, raw: str):
        if event == "connected":
            self.connected = True
            return
        if event not in {"news", "breaking"}:
            return
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return
        if isinstance(payload, dict) and isinstance(payload.get("articles"), list):
            self.connected = True
            self.ingest(payload, breaking=event == "breaking")

    # ---------- market pulse ----------
    async def pulse(self) -> dict:
        """Fear & Greed index plus per-asset news sentiment, cached for a few minutes."""
        async with self._pulse_lock:
            if self._pulse and time.monotonic() - self._pulse[0] < self.pulse_seconds:
                return self._pulse[1]
            result: dict = {"source": "cryptocurrency.cv", "as_of": now()}
            try:
                response = await self.client.get(self.base_url + "/api/fear-greed")
                response.raise_for_status()
                body = response.json()
                current = body.get("current") or {}
                result["fear_greed"] = {
                    "value": int(current["value"]),
                    "label": str(current.get("valueClassification", "")),
                    "history": [
                        {
                            "value": int(item["value"]),
                            "at": datetime.fromtimestamp(
                                int(item["timestamp"]) / 1000, timezone.utc
                            ),
                        }
                        for item in (body.get("historical") or [])[:14]
                    ],
                }
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                result["fear_greed"] = None
            sentiment = {}
            for asset in TRACKED_ASSETS:
                try:
                    response = await self.client.get(
                        self.base_url + "/api/sentiment", params={"asset": asset}
                    )
                    response.raise_for_status()
                    counts = {"bullish": 0, "bearish": 0, "neutral": 0}
                    for item in response.json().get("articles", [])[:50]:
                        label = str(item.get("sentiment", "neutral")).lower()
                        counts[label if label in counts else "neutral"] += 1
                    total = sum(counts.values())
                    sentiment[asset] = {
                        **counts,
                        "total": total,
                        "score": round((counts["bullish"] - counts["bearish"]) / total, 3)
                        if total
                        else None,
                    }
                except (httpx.HTTPError, ValueError, TypeError, AttributeError):
                    sentiment[asset] = None
            result["sentiment"] = sentiment
            self._pulse = (time.monotonic(), result)
            return result


def fixture_pulse() -> dict:
    return {
        "source": "fixture",
        "as_of": now(),
        "fear_greed": {"value": 42, "label": "Fear", "history": []},
        "sentiment": {
            asset: {"bullish": 3, "bearish": 2, "neutral": 1, "total": 6, "score": 0.167}
            for asset in TRACKED_ASSETS
        },
    }
