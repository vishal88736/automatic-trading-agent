import { useEffect, useState } from "react";
import type { Candle } from "../types";
import { platform } from "./client";
import { marketAssets, type MarketAsset } from "./market-assets";

export interface MarketQuote {
  source: string;
  status: string;
  price: string | null;
  as_of: string | null;
  candles: Candle[];
}

export interface MarketSummary {
  asset: MarketAsset;
  quote: MarketQuote | null;
  live: boolean;
  price: number | null;
  change24h: number | null;
  closes: number[];
}

const REFRESH_MS = 30_000;
let cache: { at: number; data: MarketSummary[] } | null = null;
let inflight: Promise<MarketSummary[]> | null = null;
const listeners = new Set<(data: MarketSummary[]) => void>();

function summarize(asset: MarketAsset, quote: MarketQuote | null): MarketSummary {
  const live = quote?.status === "AVAILABLE" || quote?.status === "FIXTURE";
  const closes = (quote?.candles ?? []).slice(-24).map((c) => Number(c.close));
  const price = live && quote?.price != null ? Number(quote.price) : null;
  const first = closes[0];
  return {
    asset,
    quote,
    live,
    price,
    closes,
    change24h:
      price !== null && first ? (price - first) / first : null,
  };
}

async function load(): Promise<MarketSummary[]> {
  const results = await Promise.allSettled(
    marketAssets.map((asset) =>
      platform<{ market: MarketQuote }>(`/paper-market/${asset}`),
    ),
  );
  return marketAssets.map((asset, i) => {
    const result = results[i];
    return summarize(
      asset,
      result.status === "fulfilled" ? result.value.market : null,
    );
  });
}

function refresh(force = false) {
  if (!force && cache && Date.now() - cache.at < REFRESH_MS)
    return Promise.resolve(cache.data);
  inflight ??= load()
    .then((data) => {
      cache = { at: Date.now(), data };
      listeners.forEach((listener) => listener(data));
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Shared, cached quotes for BTC, ETH and SOL. Components re-render on each refresh. */
export function useMarkets() {
  const [data, setData] = useState<MarketSummary[] | null>(cache?.data ?? null);
  useEffect(() => {
    listeners.add(setData);
    void refresh().catch(() => undefined);
    const timer = setInterval(
      () => void refresh(true).catch(() => undefined),
      REFRESH_MS,
    );
    return () => {
      listeners.delete(setData);
      clearInterval(timer);
    };
  }, []);
  return data;
}
