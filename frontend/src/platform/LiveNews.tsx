import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Radio, RefreshCw, Search, Zap } from "lucide-react";
import { Coin } from "../ui";
import { platform } from "./client";
import { marketAssets, type MarketAsset } from "./market-assets";

interface Article {
  id: string;
  title: string;
  publisher: string;
  url: string;
  published_at: string | null;
  available_at: string;
  assets: string[];
  category: string;
  sentiment: "bullish" | "bearish" | "neutral" | "uncertain";
  urgency: "normal" | "breaking" | "unknown";
  summary: string;
}

interface LiveFeed {
  source: string;
  live: boolean;
  updated_at: string | null;
  error: string | null;
  items: Article[];
}

interface Pulse {
  source: string;
  fear_greed: {
    value: number;
    label: string;
    history: { value: number; at: string }[];
  } | null;
  sentiment: Record<
    string,
    {
      bullish: number;
      bearish: number;
      neutral: number;
      total: number;
      score: number | null;
    } | null
  >;
}

function ago(value: string | null) {
  if (!value) return "time unknown";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function FearGreed({ pulse }: { pulse: Pulse["fear_greed"] }) {
  if (!pulse)
    return <p className="muted">Fear &amp; Greed index unavailable.</p>;
  const angle = (pulse.value / 100) * 180;
  const rad = ((180 - angle) * Math.PI) / 180;
  const x = 60 + 46 * Math.cos(rad),
    y = 60 - 46 * Math.sin(rad);
  return (
    <div className="kx-gauge">
      <svg
        viewBox="0 0 120 70"
        role="img"
        aria-label={`Fear and Greed ${pulse.value}, ${pulse.label}`}
      >
        <defs>
          <linearGradient id="kx-fg" x1="0" x2="1">
            <stop offset="0%" stopColor="var(--negative)" />
            <stop offset="50%" stopColor="var(--warning)" />
            <stop offset="100%" stopColor="var(--positive)" />
          </linearGradient>
        </defs>
        <path
          d="M14 60 A46 46 0 0 1 106 60"
          fill="none"
          stroke="url(#kx-fg)"
          strokeWidth="9"
          strokeLinecap="round"
        />
        <circle
          cx={x}
          cy={y}
          r="6"
          fill="var(--panel)"
          stroke="var(--text)"
          strokeWidth="2.5"
        />
      </svg>
      <strong className="kx-num">{pulse.value}</strong>
      <span>{pulse.label}</span>
    </div>
  );
}

export default function LiveNews() {
  const [asset, setAsset] = useState<MarketAsset | "">("");
  const [feed, setFeed] = useState<LiveFeed>();
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [breakingOnly, setBreakingOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [pulse, setPulse] = useState<Pulse>();
  const [reload, setReload] = useState(0);
  const [, tick] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    let active = true;
    const suffix = asset ? `?asset=${asset}` : "";
    setFeed(undefined);
    setError("");
    platform<LiveFeed>(`/news/live${suffix}`)
      .then((value) => active && setFeed(value))
      .catch((err: Error) => active && setError(err.message));

    const stream =
      typeof EventSource === "undefined"
        ? undefined
        : new EventSource(`/platform/news/stream${suffix}`);
    if (stream) {
      stream.onopen = () => setConnected(true);
      stream.onerror = () => setConnected(false);
      stream.addEventListener("article", (event) => {
        const article = JSON.parse((event as MessageEvent).data) as Article;
        setFeed((current) =>
          current && !current.items.some((item) => item.id === article.id)
            ? { ...current, items: [article, ...current.items].slice(0, 200) }
            : current,
        );
        setFresh((ids) => new Set(ids).add(article.id));
        timers.current.push(
          window.setTimeout(
            () =>
              setFresh((ids) => {
                const next = new Set(ids);
                next.delete(article.id);
                return next;
              }),
            90_000,
          ),
        );
      });
    }
    return () => {
      active = false;
      stream?.close();
      setConnected(false);
    };
  }, [asset, reload]);

  useEffect(() => {
    let active = true;
    const load = () =>
      platform<Pulse>("/news/pulse")
        .then((value) => active && setPulse(value))
        .catch(() => undefined);
    void load();
    const pulseTimer = setInterval(load, 300_000);
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      active = false;
      clearInterval(pulseTimer);
      clearInterval(clock);
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const articles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (feed?.items ?? []).filter(
      (item) =>
        (!breakingOnly || item.urgency === "breaking") &&
        (!needle ||
          `${item.title} ${item.publisher}`.toLowerCase().includes(needle)),
    );
  }, [feed, query, breakingOnly]);
  const breaking = feed?.items.find((item) => item.urgency === "breaking");

  return (
    <div className="kx-news">
      <section className="kx-news-main">
        <div className="kx-news-head">
          <h2>Latest crypto news</h2>
          <span
            className="kx-badge"
            data-tone={connected ? "positive" : "warning"}
            role="status"
          >
            <span className="kx-dot" aria-hidden />
            {connected ? "Live" : "Reconnecting…"}
          </span>
        </div>

        <div className="kx-news-tools">
          <label className="kx-search">
            <Search size={15} aria-hidden />
            <span className="visually-hidden">Search headlines</span>
            <input
              type="search"
              placeholder="Search headlines"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            <span className="visually-hidden">Filter by cryptocurrency</span>
            <select
              aria-label="Filter by cryptocurrency"
              value={asset}
              onChange={(event) =>
                setAsset(event.target.value as MarketAsset | "")
              }
            >
              <option value="">All coins</option>
              {marketAssets.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            aria-pressed={breakingOnly}
            onClick={() => setBreakingOnly(!breakingOnly)}
          >
            <Zap size={14} /> Breaking
          </button>
          <button
            type="button"
            className="kx-icon-button"
            aria-label="Reload news"
            onClick={() => setReload((n) => n + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>

        {breaking && !breakingOnly && (
          <a
            className="kx-breaking"
            href={breaking.url}
            target="_blank"
            rel="noreferrer"
          >
            <span>
              <Zap size={14} aria-hidden /> Breaking
            </span>
            <strong>{breaking.title}</strong>
            <small>
              {breaking.publisher} · {ago(breaking.published_at)}
            </small>
          </a>
        )}

        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        {feed?.error && <p className="kx-callout">{feed.error}</p>}
        {!feed && !error && (
          <p className="kx-loading" role="status">
            Loading live news…
          </p>
        )}
        {feed && articles.length === 0 && (
          <p className="muted">No articles match these filters yet.</p>
        )}

        <ol className="kx-articles">
          {articles.map((article) => (
            <li
              key={article.id}
              className="kx-article"
              data-fresh={fresh.has(article.id) || undefined}
            >
              <div className="kx-article-meta">
                <span className="kx-publisher">{article.publisher}</span>
                <time dateTime={article.published_at ?? undefined}>
                  {ago(article.published_at)}
                </time>
                {fresh.has(article.id) && <span className="kx-pill">New</span>}
                {article.urgency === "breaking" && (
                  <span className="kx-side" data-side="sell">
                    Breaking
                  </span>
                )}
              </div>
              <a href={article.url} target="_blank" rel="noreferrer">
                <h3>{article.title}</h3>
              </a>
              {article.summary && article.summary !== article.title && (
                <p>{article.summary}</p>
              )}
              <div className="kx-article-tags">
                {article.assets.map((symbol) => (
                  <span key={symbol} className="kx-asset">
                    <Coin symbol={symbol} /> {symbol}
                  </span>
                ))}
                <span className="kx-tag">{article.category}</span>
                {article.sentiment !== "neutral" &&
                  article.sentiment !== "uncertain" && (
                    <span
                      className="kx-tag"
                      data-direction={
                        article.sentiment === "bullish" ? "up" : "down"
                      }
                    >
                      {article.sentiment}
                    </span>
                  )}
                <a
                  className="kx-article-link"
                  href={article.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${article.publisher} article`}
                >
                  <ExternalLink size={14} />
                </a>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <aside className="kx-news-side">
        <section className="kx-card">
          <h3 className="kx-card-title">Fear &amp; Greed index</h3>
          {pulse ? (
            <FearGreed pulse={pulse.fear_greed} />
          ) : (
            <p className="muted">Loading…</p>
          )}
          {pulse?.fear_greed?.history.length ? (
            <div className="kx-fg-history" aria-label="Last two weeks">
              {[...pulse.fear_greed.history].reverse().map((point) => (
                <span
                  key={point.at}
                  title={`${point.value} on ${new Date(point.at).toLocaleDateString()}`}
                  style={{ height: `${Math.max(6, point.value)}%` }}
                />
              ))}
            </div>
          ) : null}
        </section>
        <section className="kx-card">
          <h3 className="kx-card-title">News sentiment</h3>
          <ul className="kx-sentiment">
            {marketAssets.map((symbol) => {
              const item = pulse?.sentiment[symbol];
              return (
                <li key={symbol}>
                  <span className="kx-asset">
                    <Coin symbol={symbol} /> {symbol}
                  </span>
                  {item && item.total ? (
                    <>
                      <span
                        className="kx-sentiment-bar"
                        aria-label={`${item.bullish} bullish, ${item.bearish} bearish, ${item.neutral} neutral`}
                      >
                        <span
                          style={{ flex: item.bullish }}
                          data-direction="up"
                        />
                        <span style={{ flex: item.neutral }} />
                        <span
                          style={{ flex: item.bearish }}
                          data-direction="down"
                        />
                      </span>
                      <small>
                        {item.bullish}↑ {item.bearish}↓
                      </small>
                    </>
                  ) : (
                    <small>{pulse ? "No data" : "Loading…"}</small>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <p className="kx-footnote">
          <Radio size={13} aria-hidden /> Live from{" "}
          <a href="https://cryptocurrency.cv" target="_blank" rel="noreferrer">
            cryptocurrency.cv
          </a>
          , a free aggregator of 300+ sources. Sentiment is keyword-based and is
          not trading advice.
        </p>
      </aside>
    </div>
  );
}
