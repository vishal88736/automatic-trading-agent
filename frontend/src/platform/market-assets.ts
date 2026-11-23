import { useEffect, useState } from "react";
import { platform } from "./client";

export const marketNames = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
} as const;

export type MarketAsset = keyof typeof marketNames;
export const marketAssets = Object.keys(marketNames) as MarketAsset[];

export function useSpotAssets(enabled = true) {
  const [assets, setAssets] = useState<string[]>(marketAssets);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    platform<{ assets: string[] }>("/spot-markets")
      .then((result) => {
        if (active) setAssets(result.assets);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [enabled]);
  return { assets, error };
}
