import { useEffect, useId, useState, type CSSProperties } from "react";
import { Activity, ArrowUpRight, ChartNoAxesColumn } from "lucide-react";
import { Sparkline } from "../charts";
import { Coin, money, timestamp } from "../ui";
import type { Candle } from "../types";
import { platform } from "./client";
import { workspaceHref } from "./navigation";

type EquityMark = { at: string; equity: string };
const periods = {
  latest: "Latest marks",
  day: "Past 24 hours",
  week: "Past 7 days",
} as const;

export function PortfolioBars({ rows }: { rows: EquityMark[] }) {
  const [period, setPeriod] = useState<keyof typeof periods>("latest");
  const [highlighted, setHighlighted] = useState<string>();
  const controlId = useId();
  const currentTime = Date.now();
  const threshold = period === "day" ? 86400000 : 7 * 86400000;
  const candidates = rows.filter(
    (mark) =>
      period === "latest" || Date.parse(mark.at) >= currentTime - threshold,
  );
  const bucketSize = period === "week" ? 86400000 : 3600000;
  const buckets = new Map<number, EquityMark>();
  for (const mark of candidates) {
    buckets.set(Math.floor(Date.parse(mark.at) / bucketSize), mark);
  }
  const marks = (
    period === "latest" ? candidates : [...buckets.values()]
  ).slice(-7);
  const maximum =
    Math.max(...marks.map((mark) => Number(mark.equity)), 1) * 1.3;
  const selected =
    marks.find((mark) => mark.at === highlighted) ?? marks.at(-1);
  const label = new Intl.DateTimeFormat(
    undefined,
    period === "week"
      ? { month: "short", day: "numeric", timeZone: "UTC" }
      : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" },
  );

  return (
    <div className="portfolio-bars">
      <div className="portfolio-bars-heading">
        <div className="portfolio-reading">
          <span className="product-section-icon">
            <ChartNoAxesColumn size={16} />
          </span>
          <div>
            <h3>Portfolio performance</h3>
            <p>Recorded paper equity · UTC</p>
          </div>
        </div>
        <label className="visually-hidden" htmlFor={controlId}>
          Equity period
        </label>
        <select
          id={controlId}
          value={period}
          onChange={(event) => {
            setPeriod(event.target.value as keyof typeof periods);
            setHighlighted(undefined);
          }}
        >
          {Object.entries(periods).map(([value, title]) => (
            <option key={value} value={value}>
              {title}
            </option>
          ))}
        </select>
      </div>
      {selected ? (
        <div className="portfolio-bars-layout">
          <div className="portfolio-reading-value">
            <strong>{money(selected.equity)}</strong>
            <span>Equity at selected mark</span>
            <time dateTime={selected.at}>{timestamp(selected.at)}</time>
          </div>
          <div
            className="portfolio-bar-chart"
            role="group"
            style={
              {
                "--selected-ratio": Math.max(
                  0,
                  Number(selected.equity) / maximum,
                ),
              } as CSSProperties
            }
            aria-label="Recorded paper equity marks"
          >
            {marks.map((mark, index) => {
              const isSelected = selected.at === mark.at;
              return (
                <button
                  key={mark.at}
                  className="portfolio-bar"
                  type="button"
                  aria-label={`${timestamp(mark.at)} · ${money(mark.equity)} equity`}
                  aria-pressed={isSelected}
                  onClick={() => setHighlighted(mark.at)}
                  style={
                    {
                      "--bar-index": index,
                      "--bar-ratio": `${Math.max(0, Number(mark.equity) / maximum) * 100}%`,
                    } as CSSProperties
                  }
                >
                  <span className="portfolio-bar-track">
                    <span className="portfolio-bar-fill" />
                  </span>
                  <span>{label.format(new Date(mark.at))}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="dashboard-empty">No equity marks in this period.</p>
      )}
    </div>
  );
}

const marketAssets = ["BTC", "ETH", "SOL"] as const;
type MarketAsset = (typeof marketAssets)[number];
type MarketQuote = {
  source: string;
  status: string;
  price: string | null;
  candles: Candle[];
};

export function DashboardMarkets() {
  const [quotes, setQuotes] =
    useState<Partial<Record<MarketAsset, MarketQuote>>>();
  useEffect(() => {
    let active = true;
    async function load() {
      const results = await Promise.allSettled(
        marketAssets.map(async (asset) => {
          const { market } = await platform<{ market: MarketQuote }>(
            `/paper-market/${asset}`,
          );
          return [asset, market] as const;
        }),
      );
      if (active)
        setQuotes(
          Object.fromEntries(
            results.flatMap((result) =>
              result.status === "fulfilled" ? [result.value] : [],
            ),
          ),
        );
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="platform-product-panel dashboard-markets">
      <div className="dashboard-panel-heading">
        <h3>
          <Activity size={16} /> Market watch
        </h3>
        <a href={workspaceHref("markets")} aria-label="Open markets">
          <ArrowUpRight size={17} />
        </a>
      </div>
      <ul>
        {marketAssets.map((asset) => {
          const quote = quotes?.[asset];
          const current =
            quote?.status === "AVAILABLE" || quote?.status === "FIXTURE";
          const close =
            quote?.candles.slice(-24).map((candle) => candle.close) ?? [];
          return (
            <li key={asset} className="dashboard-market-row">
              <a href={workspaceHref("markets", `?asset=${asset}`)}>
                <Coin symbol={asset} />
                <span className="dashboard-market-name">
                  <strong>{asset} / USD</strong>
                  <small title={quote?.source}>
                    {!quotes
                      ? "Loading"
                      : quote
                        ? quote.status === "FIXTURE"
                          ? "Fixture"
                          : quote.status.toLowerCase()
                        : "Unavailable"}
                  </small>
                </span>
                <strong>{current ? money(quote.price) : "—"}</strong>
                {current && (
                  <Sparkline
                    values={close}
                    positive={Number(close.at(-1)) >= Number(close[0])}
                  />
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
