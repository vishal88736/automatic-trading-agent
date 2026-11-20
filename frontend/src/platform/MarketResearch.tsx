import { useEffect, useState } from "react";
import { CandleChart, type ChartViewport } from "../charts";
import type { Candle } from "../types";
import { money, timestamp } from "../ui";
import { platform } from "./client";
import {
  marketAssets,
  marketNames as assets,
  type MarketAsset as Asset,
} from "./market-assets";
interface Market {
  status: string;
  source: string;
  price: string | null;
  price_at: string | null;
  as_of: string | null;
  candles: Candle[];
}
interface Feed {
  articles: {
    id: string;
    title: string;
    publisher: string;
    url: string;
    published_at: string | null;
    assets: string[];
  }[];
  source: string;
  status: string;
  retrieved_at: string;
  error?: string;
  limitation?: string;
}

function News() {
  const [feed, setFeed] = useState<Feed>();
  const [asset, setAsset] = useState("");
  const [view, setView] = useState("latest");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    if (asset) params.set("asset", asset);
    if (view === "breaking") params.set("breaking", "true");
    if (refresh) params.set("refresh", "true");
    setFeed(undefined);
    setError("");
    platform<Feed>(params.size ? `/paper-news?${params}` : "/paper-news")
      .then((value) => {
        if (active) setFeed(value);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [asset, view, refresh]);
  const articles = feed?.articles.filter((item) =>
    `${item.title} ${item.publisher}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="platform-product-panel">
      <h3>
        {view === "latest" ? "Latest crypto news" : "Breaking crypto news"}
      </h3>
      <div className="platform-backtest-fields">
        <label>
          News feed
          <select
            value={view}
            onChange={(event) => {
              setRefresh(0);
              setView(event.target.value);
            }}
          >
            <option value="latest">Latest</option>
            <option value="breaking">Breaking</option>
          </select>
        </label>
        <label>
          Search headlines
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div>
          <label htmlFor="paper-news-asset">Filter by cryptocurrency</label>
          <select
            id="paper-news-asset"
            value={asset}
            onChange={(event) => {
              setRefresh(0);
              setAsset(event.target.value);
            }}
          >
            <option value="">All assets</option>
            {marketAssets.map((symbol) => (
              <option key={symbol}>{symbol}</option>
            ))}
          </select>
        </div>
      </div>
      <button
        type="button"
        disabled={!feed && !error}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh news
      </button>
      {error && <p role="alert">{error}</p>}
      {!feed && !error && <p role="status">Loading news…</p>}
      {feed && (
        <>
          <p>
            {feed.source} · {feed.status} · Retrieved{" "}
            {timestamp(feed.retrieved_at)}
          </p>
          {feed.error && <p role="status">{feed.error}</p>}
          {feed.limitation && <p>{feed.limitation}</p>}
          {articles?.length ? (
            <ul>
              {articles.map((article) => (
                <li key={article.id}>
                  <a href={article.url} target="_blank" rel="noreferrer">
                    {article.title}
                  </a>
                  <p>
                    {article.publisher} ·{" "}
                    {article.published_at
                      ? timestamp(article.published_at)
                      : "Publication time unavailable"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p>No articles for this filter.</p>
          )}
        </>
      )}
    </section>
  );
}

interface Insight {
  observations: string;
  uncertainty: string;
  source: string;
  status: string;
  asOf: string;
  model: string;
}

function MarketInsight({
  asset,
  available,
}: {
  asset: Asset;
  available: boolean;
}) {
  const [result, setResult] = useState<Insight>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function analyze() {
    setBusy(true);
    setResult(undefined);
    setError("");
    try {
      setResult(await platform<Insight>(`/market-insights/${asset}`, "POST"));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="market-insight">
      <h4>AI market insight</h4>
      <button
        type="button"
        disabled={!available || busy}
        onClick={() => void analyze()}
      >
        Generate insight for {asset}
      </button>
      {busy && <p role="status">Summarizing market observations…</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>{result.observations}</p>
          <p>{result.uncertainty}</p>
          <p>
            Model-generated · {result.model} · {result.source} · {result.status}{" "}
            · {timestamp(result.asOf)}
          </p>
        </>
      )}
    </section>
  );
}

function Markets() {
  const [asset, setAsset] = useState<Asset>(() => {
    const requested = new URLSearchParams(location.hash.split("?")[1]).get(
      "asset",
    );
    return requested && Object.hasOwn(assets, requested)
      ? (requested as Asset)
      : "BTC";
  });
  const [search, setSearch] = useState("");
  const [pins, setPins] = useState<Asset[]>([]);
  const [market, setMarket] = useState<Market>();
  const [metrics, setMetrics] = useState<Record<string, unknown> | null>();
  const [error, setError] = useState("");
  const [watchError, setWatchError] = useState("");
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<ChartViewport>({ bars: 90, offset: 0 });
  useEffect(() => {
    let active = true;
    platform<{ assets: Asset[] }>("/paper-watchlist")
      .then((value) => {
        if (active) setPins(value.assets);
      })
      .catch((err: Error) => {
        if (active) setWatchError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setMarket(undefined);
    setMetrics(null);
    setView({ bars: 90, offset: 0 });
    async function refresh() {
      try {
        const result = await platform<{
          market: Market;
          indicators: Record<string, unknown> | null;
        }>(`/paper-market/${asset}`);
        if (active) {
          setMarket(result.market);
          setMetrics(result.indicators);
          setError("");
        }
      } catch (err) {
        if (active) {
          setError((err as Error).message);
          setMarket(undefined);
          setMetrics(null);
        }
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [asset]);
  async function toggle() {
    setSaving(true);
    setWatchError("");
    const enabled = !pins.includes(asset);
    try {
      await platform(`/paper-watchlist/${asset}`, "PUT", { enabled });
      setPins((values) =>
        enabled
          ? [...values, asset]
          : values.filter((symbol) => symbol !== asset),
      );
    } catch (err) {
      setWatchError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const visible = marketAssets.filter((symbol) =>
    `${symbol} ${assets[symbol]}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <div className="platform-product-editor">
      <section className="platform-product-panel">
        <h3>Search markets</h3>
        <label htmlFor="paper-market-search">Asset name or symbol</label>
        <input
          id="paper-market-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="platform-product-actions">
          {visible.map((symbol) => (
            <button
              type="button"
              key={symbol}
              aria-pressed={asset === symbol}
              onClick={() => setAsset(symbol)}
            >
              {symbol}
            </button>
          ))}
        </div>
        {!visible.length && <p>No matching paper markets.</p>}
        <h4>Watchlist</h4>
        <div className="platform-product-actions">
          {pins.map((symbol) => (
            <button type="button" key={symbol} onClick={() => setAsset(symbol)}>
              {assets[symbol]}
            </button>
          ))}
        </div>
        {!pins.length && <p>No watched markets.</p>}
        {watchError && <p role="alert">{watchError}</p>}
      </section>
      <section className="platform-product-panel">
        <h3>
          {assets[asset]} ({asset}/USD)
        </h3>
        <button type="button" disabled={saving} onClick={() => void toggle()}>
          {pins.includes(asset) ? "Remove from watchlist" : "Add to watchlist"}
        </button>
        {error && <p role="alert">{error}</p>}
        {!market && !error && <p role="status">Loading {asset} market…</p>}
        {market && (
          <>
            <p>
              {market.source} · {market.status} · Last trade{" "}
              {timestamp(market.price_at)}
            </p>
            <p>
              {market.status === "AVAILABLE" || market.status === "FIXTURE"
                ? money(market.price)
                : "Fresh price unavailable"}
            </p>
            {metrics && (
              <dl className="platform-backtest-metrics">
                {[
                  ["RSI", metrics.rsi],
                  ["ATR", metrics.atr],
                  ["MACD", metrics.macd],
                  ["Regime", metrics.regime],
                ].map(([name, value]) => (
                  <div key={String(name)}>
                    <dt>{String(name)}</dt>
                    <dd>
                      {typeof value === "number"
                        ? value.toFixed(2)
                        : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {market.candles.length > 0 && (
              <CandleChart
                candles={market.candles}
                view={view}
                onViewChange={setView}
                showRsi
              />
            )}
          </>
        )}
        <MarketInsight
          key={asset}
          asset={asset}
          available={
            Boolean(metrics) &&
            (market?.status === "AVAILABLE" || market?.status === "FIXTURE")
          }
        />
      </section>
    </div>
  );
}

export default function MarketResearch({ news }: { news: boolean }) {
  return news ? <News /> : <Markets />;
}
