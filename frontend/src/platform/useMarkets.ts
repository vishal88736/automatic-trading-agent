import { useEffect, useState } from "react";
import { platform } from "./client";
import { marketAssets, type MarketAsset } from "./market-assets";

interface PriceQuote {
  asset: MarketAsset;
  price: string;
  open_24h: string;
  high_24h: string;
  low_24h: string;
  volume_24h_usdt: string;
  change_24h: string | null;
  at: string;
}

export interface MarketSummary {
  asset: MarketAsset;
  live: boolean;
  price: number | null;
  change24h: number | null;
  high24h: number | null;
  low24h: number | null;
  direction: "up" | "down" | null;
}

// One shared snapshot and SSE connection for every component on the page.
let state: Record<string, MarketSummary> = {};
let source: EventSource | null = null;
let users = 0;
let retry: number | undefined;
let backoff = 3000;
const listeners = new Set<(data: MarketSummary[]) => void>();

function list(): MarketSummary[] {
  return marketAssets.map(
    (asset) =>
      state[asset] ?? {
        asset,
        live: false,
        price: null,
        change24h: null,
        high24h: null,
        low24h: null,
        direction: null,
      },
  );
}

function apply(item: PriceQuote) {
  const previous = state[item.asset]?.price ?? null;
  const price = Number(item.price);
  state = {
    ...state,
    [item.asset]: {
      asset: item.asset,
      live: true,
      price,
      change24h: item.change_24h === null ? null : Number(item.change_24h),
      high24h: Number(item.high_24h),
      low24h: Number(item.low_24h),
      direction:
        previous === null || previous === price
          ? (state[item.asset]?.direction ?? null)
          : price > previous
            ? "up"
            : "down",
    },
  };
}

function publish() {
  const data = list();
  listeners.forEach((listener) => listener(data));
}

function connect() {
  void platform<{ prices: Record<string, PriceQuote> }>("/public/prices")
    .then(({ prices }) => {
      Object.values(prices).forEach(apply);
      publish();
    })
    .catch(() => undefined);
  if (typeof EventSource === "undefined") return;
  source = new EventSource("/platform/public/prices/stream");
  source.onopen = () => {
    backoff = 3000;
  };
  source.addEventListener("price", (event) => {
    apply(JSON.parse((event as MessageEvent).data) as PriceQuote);
    publish();
  });
  source.onerror = () => {
    // A closed stream (outage, rate limit) reconnects with exponential backoff.
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      retry = window.setTimeout(() => users && connect(), backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  };
}

/** Live Binance prices for BTC, ETH and SOL, shared across components. */
export function useMarkets() {
  const [data, setData] = useState<MarketSummary[] | null>(
    Object.keys(state).length ? list() : null,
  );
  useEffect(() => {
    listeners.add(setData);
    if (users++ === 0) connect();
    return () => {
      listeners.delete(setData);
      if (--users === 0) {
        source?.close();
        source = null;
        clearTimeout(retry);
      }
    };
  }, []);
  return data;
}
