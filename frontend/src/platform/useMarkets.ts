import { useEffect, useState } from "react";
import { platform } from "./client";
import { marketAssets } from "./market-assets";

interface PriceQuote {
  asset: string;
  price: string;
  open_24h: string;
  high_24h: string;
  low_24h: string;
  volume_24h_usdt: string;
  change_24h: string | null;
  at: string;
}

export interface MarketSummary {
  asset: string;
  live: boolean;
  price: number | null;
  change24h: number | null;
  high24h: number | null;
  low24h: number | null;
  direction: "up" | "down" | null;
  observedAt: number | null;
  history: number[];
}

// Hourly closes for the past day, per asset, from the price snapshot. Sparklines draw
// these and end at the live price, so they show the same 24h move as the change label.
let dayCloses: Record<string, number[]> = {};

// One shared snapshot and SSE connection for every component on the page.
let state: Record<string, MarketSummary> = {};
let featured: readonly string[] = marketAssets;
let source: EventSource | null = null;
let retry: number | undefined;
let backoff = 3000;
const listeners = new Set<(data: MarketSummary[]) => void>();

function list(): MarketSummary[] {
  return featured.map(
    (asset) =>
      state[asset] ?? {
        asset,
        live: false,
        price: null,
        change24h: null,
        high24h: null,
        low24h: null,
        direction: null,
        observedAt: null,
        history: [],
      },
  );
}

function apply(item: PriceQuote) {
  const last = state[item.asset];
  const previous = last?.price ?? null;
  const price = Number(item.price);
  const observedAt = Date.parse(item.at);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(observedAt) ||
    (last?.observedAt != null && observedAt < last.observedAt)
  )
    return;
  const closes = dayCloses[item.asset];
  const history = last?.history ?? [];
  const previousSamples =
    observedAt === last?.observedAt ? history.slice(0, -1) : history;
  const series = closes?.length
    ? [...closes.slice(1), price]
    : [...previousSamples.slice(-31), price];
  state = {
    ...state,
    [item.asset]: {
      asset: item.asset,
      live: true,
      price,
      change24h: finiteQuoteNumber(item.change_24h),
      high24h: finiteQuoteNumber(item.high_24h),
      low24h: finiteQuoteNumber(item.low_24h),
      observedAt,
      history: series,
      direction:
        previous === null || previous === price
          ? (last?.direction ?? null)
          : price > previous
            ? "up"
            : "down",
    },
  };
}

function finiteQuoteNumber(value: string | null) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function publish() {
  const data = list();
  listeners.forEach((listener) => listener(data));
}

function connect() {
  if (!listeners.size || source) return;
  void platform<{
    assets?: string[];
    prices: Record<string, PriceQuote>;
    history?: Record<string, string[]>;
  }>("/public/prices")
    .then(({ assets, prices, history }) => {
      if (assets?.length) featured = assets;
      dayCloses = Object.fromEntries(
        Object.entries(history ?? {}).map(([asset, closes]) => [
          asset,
          closes
            .map(Number)
            .filter((close) => Number.isFinite(close) && close > 0),
        ]),
      );
      Object.values(prices).forEach(apply);
      publish();
    })
    .catch(() => undefined);
  if (typeof EventSource === "undefined") return;
  const connection = new EventSource("/platform/public/prices/stream");
  source = connection;
  connection.onopen = () => {
    if (source === connection) backoff = 3000;
  };
  connection.addEventListener("price", (event) => {
    if (source !== connection) return;
    try {
      apply(JSON.parse((event as MessageEvent).data) as PriceQuote);
    } catch {
      return;
    }
    publish();
  });
  connection.onerror = () => {
    if (source !== connection) return;
    connection.close();
    source = null;
    retry = window.setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60000);
  };
}

/** Configured live Binance prices, shared across components. */
export function useMarkets() {
  const [data, setData] = useState<MarketSummary[] | null>(
    Object.keys(state).length ? list() : null,
  );
  useEffect(() => {
    listeners.add(setData);
    if (listeners.size === 1) connect();
    return () => {
      listeners.delete(setData);
      if (!listeners.size) {
        source?.close();
        source = null;
        clearTimeout(retry);
        backoff = 3000;
      }
    };
  }, []);
  return data;
}
