export const marketNames = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
} as const;

export type MarketAsset = keyof typeof marketNames;
export const marketAssets = Object.keys(marketNames) as MarketAsset[];
