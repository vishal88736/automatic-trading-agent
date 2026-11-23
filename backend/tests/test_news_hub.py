import asyncio
import json
from datetime import datetime, timezone

import httpx

from backend.models import now
from backend.product.news_hub import NewsHub


def article(title, link, minutes_ago=1):
    published = now().timestamp() - minutes_ago * 60
    return {
        "title": title,
        "link": link,
        "description": f"{title} summary",
        "pubDate": datetime.fromtimestamp(published, timezone.utc).isoformat(),
        "source": "Wire",
        "category": "bitcoin",
    }


async def test_ingest_deduplicates_and_notifies_subscribers():
    hub = NewsHub("https://news.test", stream=False)
    queue = hub.subscribe()
    first = hub.ingest(
        {
            "articles": [
                article("Bitcoin ETF inflows surge", "https://a.test/1"),
                article("Ethereum upgrade ships", "https://a.test/2", 5),
            ]
        }
    )
    assert len(first) == 2 and queue.qsize() == 2
    again = hub.ingest({"articles": [article("Bitcoin ETF inflows surge", "https://a.test/1")]})
    assert again == [] and queue.qsize() == 2
    hub.ingest(
        {"articles": [article("Bitcoin ETF inflows surge", "https://a.test/1")]}, breaking=True
    )
    assert hub.snapshot("BTC")[0].urgency == "breaking"
    assert [a.title for a in hub.snapshot("ETH")] == ["Ethereum upgrade ships"]
    hub.unsubscribe(queue)
    await hub.client.aclose()


async def test_buffer_is_bounded_to_the_newest_articles():
    hub = NewsHub("https://news.test", stream=False, buffer=3)
    hub.ingest(
        {
            "articles": [
                article(f"Bitcoin story {i}", f"https://a.test/{i}", minutes_ago=i)
                for i in range(6)
            ]
        }
    )
    assert [a.title for a in hub.snapshot()] == [f"Bitcoin story {i}" for i in range(3)]
    await hub.client.aclose()


async def test_stream_events_and_rest_fallback_feed_the_hub():
    stream_body = (
        'event: connected\ndata: {"message":"ok"}\n\n'
        "event: heartbeat\ndata: {}\n\n"
        f"event: breaking\ndata: {json.dumps({'articles': [article('Solana halts', 'https://s.test/1')]})}\n\n"
        f"event: news\ndata: {json.dumps({'articles': [article('Bitcoin dips', 'https://s.test/2')]})}\n\n"
    )

    def handler(request: httpx.Request):
        if request.url.path == "/api/sse":
            return httpx.Response(
                200, text=stream_body, headers={"content-type": "text/event-stream"}
            )
        if request.url.path == "/api/news":
            return httpx.Response(
                200, json={"articles": [article("Ethereum rally", "https://r.test/1")]}
            )
        if request.url.path == "/api/breaking":
            return httpx.Response(200, json={"articles": []})
        if request.url.path == "/api/fear-greed":
            return httpx.Response(
                200,
                json={
                    "current": {"value": 21, "valueClassification": "Extreme Fear"},
                    "historical": [
                        {"value": 21, "timestamp": 1795219200000},
                        {"value": 30, "timestamp": 1795132800000},
                    ],
                },
            )
        if request.url.path == "/api/search":
            assert request.url.params["q"] == "Cardano"
            return httpx.Response(
                200,
                json={
                    "articles": [
                        article("Cardano roadmap update", "https://r.test/ada"),
                        article("Unrelated market update", "https://r.test/unrelated"),
                    ]
                },
            )
        return httpx.Response(404)

    hub = NewsHub("https://news.test", transport=httpx.MockTransport(handler))
    async with hub.client.stream("GET", "https://news.test/api/sse") as response:
        await hub._consume(response)
    assert hub.connected
    titles = {a.title: a for a in hub.snapshot()}
    assert titles["Solana halts"].urgency == "breaking"
    assert titles["Bitcoin dips"].urgency == "normal"

    await hub.refresh()
    assert "Ethereum rally" in {a.title for a in hub.snapshot()}

    pulse = await hub.pulse()
    assert pulse["fear_greed"]["value"] == 21
    assert pulse["fear_greed"]["label"] == "Extreme Fear"
    assert pulse["sentiment"]["BTC"]["total"] == 1
    assert pulse["sentiment"]["ETH"]["total"] == 1
    assert pulse["sentiment"]["SOL"]["total"] == 1
    matches, search_available = await hub.asset_snapshot("ADA", 10)
    assert search_available
    assert [item.title for item in matches] == ["Cardano roadmap update"]
    assert await hub.pulse() is pulse  # cached
    await hub.client.aclose()


async def test_unreachable_provider_reports_an_error_without_crashing():
    hub = NewsHub(
        "https://news.test",
        stream=False,
        transport=httpx.MockTransport(lambda request: httpx.Response(503)),
        poll_seconds=0.01,
    )
    await hub.start()
    await asyncio.sleep(0.05)
    assert hub.status()["error"]
    assert (await hub.pulse())["fear_greed"] is None
    await hub.stop()
