export type Amount = string | number;

export interface Candle {
  timestamp: string;
  closed_at: string;
  open: Amount;
  high: Amount;
  low: Amount;
  close: Amount;
  volume: Amount;
}

export interface ChartPoint {
  timestamp: string;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

export interface ChartIndicators {
  source: string;
  timeframe: string;
  status: string;
  reason: string | null;
  method: string;
  points: ChartPoint[];
}
