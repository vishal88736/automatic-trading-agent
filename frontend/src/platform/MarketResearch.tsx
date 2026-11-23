import { useEffect, useRef, useState } from "react";
import { Bookmark, Search, Sparkles } from "lucide-react";
import { CandleChart, type ChartViewport } from "../charts";
import type { Candle } from "../types";
import { Coin, money, timestamp } from "../ui";
import { platform } from "./client";
import { useSpotAssets, marketNames as assets } from "./market-assets";
type Asset = string;
const names: Readonly<Record<string, string>> = assets;

interface Market {
  status: string;
  source: string;
  price: string | null;
  price_at: string | null;
  as_of: string | null;
  candles: Candle[];
}
interface Insight {
  summary?: string;
  observations: string | string[];
  uncertainty: string;
  news_analysis?: string | string[];
  newsStatus?: string;
  headlines?: {
    title: string;
    publisher: string;
    url: string;
    scope: "asset" | "broader market";
    published_at: string | null;
  }[];

  source: string;
  status: string;
  asOf: string | null;
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
    <section className="platform-product-panel kx-market-insight">
      <div className="kx-insight-header">
        <h3>
          <Sparkles size={17} aria-hidden /> AI market insight
        </h3>
        <button
          type="button"
          disabled={!available || busy}
          onClick={() => void analyze()}
        >
          Generate insight for {asset}
        </button>
      </div>
      {!available && (
        <p className="muted">
          Choose a supported market to generate an insight.
        </p>
      )}
      {busy && <p role="status">Analyzing the chart and recent news…</p>}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          {result.summary && (
            <p className="kx-insight-summary">{result.summary}</p>
          )}
          <div className="kx-insight-findings">
            <div>
              <h4>Chart analysis</h4>
              {result.status === "STALE" && (
                <p className="muted">
                  Based on recorded candles. Current chart data is limited.
                </p>
              )}
              {result.status === "NEWS_ONLY" && (
                <p className="muted">Hourly candles unavailable.</p>
              )}
              <ul>
                {[result.observations].flat().map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4>News analysis</h4>
              <ul>
                {[
                  result.news_analysis ??
                    "The current backend returned chart analysis only.",
                ]
                  .flat()
                  .map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
              </ul>
            </div>
          </div>
          {!!result.headlines?.length && (
            <details>
              <summary>Headlines used ({result.headlines.length})</summary>
              <ul>
                {result.headlines.map((item) => (
                  <li key={item.url}>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>
                    <small>
                      {" "}
                      · {item.publisher} · {item.scope}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="kx-insight-limits">
            <h4>Limitations</h4>
            <p>{result.uncertainty}</p>
          </div>
          <p className="kx-insight-meta muted">
            {result.model === "krono-rules"
              ? "Rules-based summary"
              : result.model}{" "}
            · {result.source}
            {result.asOf ? ` · ${timestamp(result.asOf)}` : ""}
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
    return requested && /^[A-Z0-9]{2,20}$/.test(requested)
      ? (requested as Asset)
      : "BTC";
  });
  const [search, setSearch] = useState("");
  const marketPicker = useRef<HTMLDetailsElement>(null);
  const marketToggle = useRef<HTMLElement>(null);
  const { assets: spotAssets, error: catalogError } = useSpotAssets();
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
  const visible = spotAssets.filter((symbol) =>
    `${symbol} ${names[symbol] ?? symbol}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <div className="kx-stack">
      <section className="platform-product-panel kx-market-filters">
        <div className="kx-market-filter">
          <h3>Market</h3>
          <details ref={marketPicker} className="kx-market-picker">
            <summary ref={marketToggle}>
              <strong>{asset}/USD</strong>
              <span>Browse markets</span>
            </summary>
            <div className="kx-market-picker-content">
              <label htmlFor="paper-market-search">Asset name or symbol</label>
              <div className="kx-market-search">
                <Search size={16} aria-hidden />
                <input
                  type="search"
                  id="paper-market-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div
                className="platform-product-actions kx-market-results"
                role="group"
                aria-label="Markets"
              >
                {visible.map((symbol) => (
                  <button
                    type="button"
                    key={symbol}
                    aria-pressed={asset === symbol}
                    onClick={() => {
                      setAsset(symbol);
                      setSearch("");
                      if (marketPicker.current)
                        marketPicker.current.open = false;
                      marketToggle.current?.focus();
                    }}
                  >
                    {symbol}
                  </button>
                ))}
              </div>
              {!visible.length && (
                <p className="muted">No matching paper markets.</p>
              )}
            </div>
          </details>
          {catalogError && <p role="alert">{catalogError}</p>}
        </div>
        <div className="kx-market-filter">
          <h3>Watchlist</h3>
          <div className="platform-product-actions">
            {pins.map((symbol) => (
              <button
                type="button"
                key={symbol}
                aria-pressed={asset === symbol}
                onClick={() => setAsset(symbol)}
              >
                {names[symbol] ?? symbol}
              </button>
            ))}
          </div>
          {!pins.length && <p className="muted">No watched markets.</p>}
          {watchError && <p role="alert">{watchError}</p>}
        </div>
      </section>
      <section className="platform-product-panel kx-market-chart">
        <div className="kx-toolbar">
          <h3>
            <span aria-hidden>
              <Coin symbol={asset} />
            </span>{" "}
            {names[asset] ?? asset} ({asset}/USD)
          </h3>
          <button
            className="secondary"
            type="button"
            disabled={saving}
            onClick={() => void toggle()}
          >
            <Bookmark size={15} aria-hidden />
            {pins.includes(asset)
              ? "Remove from watchlist"
              : "Add to watchlist"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!market && !error && <p role="status">Loading {asset} market…</p>}
        {market && (
          <>
            <p className="kx-market-price kx-num">
              {market.status === "AVAILABLE" || market.status === "FIXTURE"
                ? money(market.price)
                : "Fresh price unavailable"}
            </p>
            <p className="muted">
              {market.source} · {market.status} · Last trade{" "}
              {timestamp(market.price_at)}
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
              <div className="kx-market-plot">
                <CandleChart
                  candles={market.candles}
                  view={view}
                  onViewChange={setView}
                  showRsi
                />
              </div>
            )}
          </>
        )}
      </section>
      <MarketInsight
        key={asset}
        asset={asset}
        available={spotAssets.includes(asset) || market != null}
      />
    </div>
  );
}

export default function MarketResearch() {
  return <Markets />;
}
