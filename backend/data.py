from __future__ import annotations

import asyncio
import hashlib
import math
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from html import unescape
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from backend.models import Article, Candle, Market, NewsFeed, NewsScoring, Token, now
from backend.storage import Store

D = Decimal
ASSETS = {
    "BTC": Token(asset_id="BTC", symbol="BTC", name="Bitcoin"),
    "ETH": Token(asset_id="ETH", symbol="ETH", name="Ethereum"),
    "SOL": Token(asset_id="SOL", symbol="SOL", name="Solana"),
}
USD = Token(asset_id="USD", symbol="USD", name="Simulated US dollar")
FIXTURE_START = datetime(2026, 1, 10, tzinfo=timezone.utc)


def fixture_market(symbol: str, count=238) -> Market:
    base = {"BTC": 67000, "ETH": 3200, "SOL": 145}[symbol]
    bars = []
    previous = base
    phase = {"BTC": 0, "ETH": 1.1, "SOL": 2.2}[symbol]
    for index in range(count):
        # Reproducible synthetic path: trend, cyclic pullbacks, widening recent participation.
        close = base * (
            1
            + index * 0.00035
            + 0.006 * math.sin(index * 0.48 + phase)
            + 0.003 * math.sin(index * 0.13)
        )
        high = max(previous, close) * 1.0018
        low = min(previous, close) * 0.9982
        start = FIXTURE_START + timedelta(hours=index)
        bars.append(
            Candle(
                timestamp=start,
                closed_at=start + timedelta(hours=1),
                open=D(str(round(previous, 8))),
                high=D(str(round(high, 8))),
                low=D(str(round(low, 8))),
                close=D(str(round(close, 8))),
                volume=D(
                    str(
                        round(
                            (100 + index * 0.3)
                            * (1.45 if index > count - 4 else 1)
                            * (1 + 0.1 * math.sin(index)),
                            5,
                        )
                    )
                ),
            )
        )
        previous = close
    return Market(
        asset=ASSETS[symbol],
        candles=bars,
        source="synthetic_fixture_v1",
        retrieved_at=now(),
        as_of=bars[-1].closed_at,
        status="FIXTURE",
        price=bars[-1].close,
        price_at=bars[-1].closed_at,
        liquidity_usd=D("1000000"),
        limitation="Deterministic synthetic hourly history and assumed $1m simulation liquidity. No executable DEX price or measured liquidity.",
    )


def canonical_url(raw: str) -> str:
    parts = urlsplit(raw.strip())
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username
        or parts.password
    ):
        raise ValueError("Article link must be a public HTTP(S) URL")
    if parts.hostname in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Local article links are invalid")
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query)
        if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid", "ref"}
    ]
    return urlunsplit(
        (
            parts.scheme.lower(),
            parts.netloc.lower(),
            parts.path.rstrip("/") or "/",
            urlencode(sorted(query)),
            "",
        )
    )


def text_content(raw, limit=1500):
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]*>", " ", str(raw or "")))).strip()[:limit]


def parse_time(raw) -> datetime | None:
    try:
        value = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        return value.astimezone(timezone.utc) if value.tzinfo else None
    except (ValueError, TypeError):
        return None


def normalize_news(
    payload: dict, retrieved: datetime, breaking=False, scoring: NewsScoring | None = None
) -> list[Article]:
    scoring = scoring or NewsScoring()
    if not isinstance(payload, dict) or not isinstance(payload.get("articles"), list):
        raise ValueError("News response has no articles array")
    articles = []
    seen_urls, seen_titles = set(), set()
    for raw in payload["articles"][:200]:
        if not isinstance(raw, dict):
            continue
        try:
            title = text_content(raw.get("title"), 1000)
            url = canonical_url(str(raw.get("link") or raw.get("url") or ""))
            normalized_title = re.sub(r"[^\w]+", " ", title.casefold()).strip()
            if not title or url in seen_urls or normalized_title in seen_titles:
                continue
            seen_urls.add(url)
            seen_titles.add(normalized_title)
            description = text_content(raw.get("description"))
            content = f"{title} {description}"
            patterns = {
                "BTC": r"\bbitcoin\b|\bBTC\b",
                "ETH": r"\bethereum\b|\bETH\b",
                "SOL": r"\bsolana\b|\$SOL\b",
            }
            assets = [
                symbol for symbol, pattern in patterns.items() if re.search(pattern, content, re.I)
            ]
            published = parse_time(raw.get("pubDate") or raw.get("publishedAt"))
            valid_time = published is not None and published <= retrieved + timedelta(minutes=5)
            positive = len(
                re.findall(
                    r"\b(" + "|".join(map(re.escape, scoring.positive_terms)) + r")\b",
                    content,
                    re.I,
                )
            )
            negative = len(
                re.findall(
                    r"\b(" + "|".join(map(re.escape, scoring.negative_terms)) + r")\b",
                    content,
                    re.I,
                )
            )
            sentiment = (
                "uncertain"
                if positive and negative
                else "bullish"
                if positive
                else "bearish"
                if negative
                else "neutral"
            )
            confidence = (
                min(
                    scoring.maximum_confidence,
                    scoring.base_confidence + abs(positive - negative) * scoring.term_weight,
                )
                if positive or negative
                else min(0.3, scoring.maximum_confidence)
            )
            actionable = (
                raw.get("contentType", "news") == "news"
                and "/gastracker" not in url
                and bool(assets)
            )
            stale = bool(payload.get("_stale")) or bool(
                published and retrieved - published > timedelta(hours=6)
            )
            articles.append(
                Article(
                    id=hashlib.sha256(url.encode()).hexdigest()[:20],
                    title=title,
                    publisher=text_content(raw.get("source") or urlsplit(url).hostname, 150),
                    url=url,
                    published_at=published,
                    retrieved_at=retrieved,
                    available_at=retrieved,
                    assets=assets,
                    category=text_content(raw.get("category") or "general", 80),
                    sentiment=sentiment,
                    confidence=confidence,
                    relevance=0.8 if assets else 0.0,
                    urgency="breaking"
                    if breaking and valid_time and retrieved - published < timedelta(hours=2)
                    else "normal",
                    summary=description or title,
                    stale=stale,
                    actionable_content=actionable and valid_time,
                    limitations=["Lexicon sentiment estimate; no article-body verification."]
                    + (
                        []
                        if valid_time
                        else [
                            "Missing or invalid publication time; excluded from trading evidence."
                        ]
                    ),
                )
            )
        except (ValueError, TypeError):
            continue
    return sorted(
        articles,
        key=lambda a: a.published_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )


def fixture_news() -> NewsFeed:
    clock = fixture_market("BTC").as_of
    examples = [
        (
            "Fixture research: Bitcoin adoption rises as market participation grows",
            "BTC",
            "Fixture wire A",
            "bullish",
        ),
        (
            "Fixture report: Bitcoin inflows improve alongside a price recovery",
            "BTC",
            "Fixture wire B",
            "bullish",
        ),
        (
            "Fixture brief: Ethereum upgrade review highlights execution risks",
            "ETH",
            "Fixture wire C",
            "uncertain",
        ),
        (
            "Fixture monitor: Solana liquidity remains under review",
            "SOL",
            "Fixture wire A",
            "neutral",
        ),
    ]
    return NewsFeed(
        status="FIXTURE",
        source="synthetic_fixture_v1",
        retrieved_at=now(),
        articles=[
            Article(
                id=f"fixture-{i}",
                title=title,
                publisher=publisher,
                url=f"https://wire-{i}.example.invalid/fixtures/{i}",
                published_at=clock - timedelta(minutes=20 + i * 8),
                retrieved_at=now(),
                available_at=clock - timedelta(minutes=15 + i * 8),
                assets=[asset],
                sentiment=sentiment,
                confidence=0.5,
                relevance=0.8,
                urgency="breaking" if i < 2 else "normal",
                summary="Synthetic development story. This is a fixture, not a report of a real event.",
                summary_kind="fixture",
                fixture=True,
                limitations=["Synthetic story; suitable only for simulation."],
            )
            for i, (title, asset, publisher, sentiment) in enumerate(examples)
        ],
    )


class Providers:
    def __init__(
        self,
        store: Store,
        market_provider="fixture",
        news_provider="fixture",
        transport=None,
        news_key="",
    ):
        self.store, self.market_provider, self.news_provider = store, market_provider, news_provider
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(8, connect=4),
            transport=transport,
            follow_redirects=False,
            limits=httpx.Limits(max_connections=4),
            headers={"User-Agent": "HSK-Agent-Terminal/0.1"},
        )
        self.news_key = news_key
        self.semaphore = asyncio.Semaphore(3)
        self.locks: dict[str, asyncio.Lock] = {}
        self.errors: dict[str, int] = {}
        self.store.config("news_scoring", NewsScoring().model_dump(mode="json"))

    async def close(self):
        await self.client.aclose()

    async def request(self, url, **kwargs):
        async with self.semaphore:
            for attempt in range(2):
                try:
                    result = await self.client.get(url, **kwargs)
                    result.raise_for_status()
                    return result.json()
                except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
                    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code < 500:
                        raise
                    if attempt:
                        raise
                    await asyncio.sleep(0.2)

    async def market(self, symbol: str, refresh=False) -> Market:
        if symbol not in ASSETS:
            raise ValueError("Unsupported asset")
        if self.market_provider == "fixture":
            return fixture_market(symbol)
        key = f"market:{symbol}"
        async with self.locks.setdefault(key, asyncio.Lock()):
            cached = self.store.get("cache", key)
            if (
                cached
                and not refresh
                and (now() - Market.model_validate(cached).retrieved_at).total_seconds() < 300
            ):
                result = Market.model_validate(cached)
                if (
                    result.price_at is None
                    or (now() - result.price_at).total_seconds() > 300
                    or result.as_of is None
                    or now() - result.as_of > timedelta(hours=2)
                ):
                    result.status = "STALE"
                return result
            try:
                rows, ticker = await asyncio.gather(
                    self.request(
                        f"https://api.exchange.coinbase.com/products/{symbol}-USD/candles",
                        params={"granularity": "3600"},
                    ),
                    self.request(f"https://api.exchange.coinbase.com/products/{symbol}-USD/ticker"),
                )
                if not isinstance(rows, list) or not isinstance(ticker, dict):
                    raise ValueError("Malformed market response")
                unique = {}
                for row in rows[:1000]:
                    if not isinstance(row, list) or len(row) != 6:
                        raise ValueError("Invalid candle shape")
                    start = datetime.fromtimestamp(float(row[0]), timezone.utc)
                    bar = Candle(
                        timestamp=start,
                        closed_at=start + timedelta(hours=1),
                        low=D(str(row[1])),
                        high=D(str(row[2])),
                        open=D(str(row[3])),
                        close=D(str(row[4])),
                        volume=D(str(row[5])),
                    )
                    if bar.closed_at <= now():
                        if start in unique and unique[start] != bar:
                            raise ValueError("Conflicting duplicate candles")
                        unique[start] = bar
                bars = sorted(unique.values(), key=lambda c: c.timestamp)[-300:]
                if not bars:
                    raise ValueError("No closed candles")
                price_time = parse_time(ticker.get("time"))
                if not price_time or price_time > now() + timedelta(minutes=1):
                    raise ValueError("Invalid ticker time")
                market = Market(
                    asset=ASSETS[symbol],
                    candles=bars,
                    source="coinbase_exchange",
                    retrieved_at=now(),
                    as_of=bars[-1].closed_at,
                    status="STALE"
                    if (now() - price_time).total_seconds() > 300
                    or now() - bars[-1].closed_at > timedelta(hours=2)
                    else "AVAILABLE",
                    price=D(str(ticker["price"])),
                    price_at=price_time,
                    limitation="Coinbase CEX reference price and closed hourly candles. Not an HSKSwap executable quote. DEX liquidity is unavailable. Ticker and candle observations are separate; at most two hours of candle lag is accepted.",
                )
                self.store.put("cache", key, market)
                return market
            except (httpx.HTTPError, ValueError, TypeError, KeyError, OverflowError):
                self.errors["market"] = self.errors.get("market", 0) + 1
                if cached:
                    return Market.model_validate(cached).model_copy(
                        update={
                            "status": "STALE",
                            "limitation": "Provider unavailable; cached reference data. No executable quote.",
                        }
                    )
                return Market(
                    asset=ASSETS[symbol],
                    source="coinbase_exchange",
                    retrieved_at=now(),
                    status="UNAVAILABLE",
                    limitation="Market provider unavailable or malformed response.",
                )

    async def news(self, breaking=False, refresh=False) -> NewsFeed:
        if self.news_provider == "fixture":
            return fixture_news()
        scoring, version = self.store.config("news_scoring")
        key = f"news:breaking:v{version}" if breaking else f"news:latest:v{version}"
        async with self.locks.setdefault(key, asyncio.Lock()):
            cached = self.store.get("cache", key)
            if (
                cached
                and not refresh
                and (now() - NewsFeed.model_validate(cached).retrieved_at).total_seconds() < 120
            ):
                return NewsFeed.model_validate(cached)
            try:
                headers = {"X-API-Key": self.news_key} if self.news_key else {}
                payload = await self.request(
                    "https://cryptocurrency.cv/api/breaking"
                    if breaking
                    else "https://cryptocurrency.cv/api/news",
                    headers=headers,
                )
                retrieved = now()
                articles = normalize_news(
                    payload, retrieved, breaking, NewsScoring.model_validate(scoring)
                )
                for article in articles:
                    first_seen = self.store.get("cache", "news_seen:" + article.id)
                    if first_seen:
                        article.available_at = datetime.fromisoformat(first_seen["available_at"])
                    else:
                        self.store.put(
                            "cache",
                            "news_seen:" + article.id,
                            {"available_at": article.available_at},
                        )
                if payload.get("articles") and not articles:
                    raise ValueError("No valid news items")
                feed = NewsFeed(
                    articles=articles,
                    status="STALE" if payload.get("_stale") else "AVAILABLE",
                    source="cryptocurrency.cv",
                    retrieved_at=retrieved,
                    scoring_version=version,
                )
                self.store.put("cache", key, feed)
                return feed
            except (httpx.HTTPError, ValueError, TypeError, KeyError):
                self.errors["news"] = self.errors.get("news", 0) + 1
                if cached:
                    feed = NewsFeed.model_validate(cached)
                    feed.status = "STALE"
                    feed.error = "Provider unavailable; original retrieval timestamps retained. No automatic payments."
                    feed.articles = [
                        article.model_copy(update={"stale": True}) for article in feed.articles
                    ]
                    return feed
                return NewsFeed(
                    status="UNAVAILABLE",
                    source="cryptocurrency.cv",
                    retrieved_at=now(),
                    error="News unavailable or access denied. No automatic payments or website scraping.",
                )
