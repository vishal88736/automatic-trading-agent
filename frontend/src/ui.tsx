import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { Amount } from "./types";

export const money = (value: Amount | null | undefined, digits = 2) =>
  value === null || value === undefined
    ? "—"
    : Number(value).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
export const number = (value: Amount | null | undefined, digits = 4) =>
  value === null || value === undefined
    ? "—"
    : Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
export const percent = (value: Amount | null | undefined, digits = 2) =>
  value === null || value === undefined
    ? "—"
    : `${(Number(value) * 100).toFixed(digits)}%`;
export const timestamp = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }) + " UTC"
    : "Unavailable";

export function Delta({ value }: { value: Amount | null | undefined }) {
  const positive = Number(value) >= 0;
  return (
    <span
      className={
        value == null ? "muted" : positive ? "text-positive" : "text-negative"
      }
    >
      {value != null &&
        (positive ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />)}
      {percent(value)}
    </span>
  );
}
export function Coin({ symbol }: { symbol: string }) {
  return (
    <span className={`coin coin-${symbol.toLowerCase()}`}>
      {symbol === "BTC"
        ? "₿"
        : symbol === "ETH"
          ? "Ξ"
          : symbol === "SOL"
            ? "≋"
            : "$"}
    </span>
  );
}
