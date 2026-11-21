import { useEffect, useState, type CSSProperties } from "react";
import {
  Activity,
  ArrowUpRight,
  ChartNoAxesColumn,
  FlaskConical,
  PieChart,
  Wallet,
} from "lucide-react";
import { EquityChart, Sparkline } from "../charts";
import { Coin, Delta, money, number, percent, timestamp } from "../ui";
import type { Candle } from "../types";
import { platform } from "./client";
import { marketAssets, type MarketAsset } from "./market-assets";
import { workspaceHref } from "./navigation";

export interface PaperPosition {
  asset: string;
  agent_id: string | null;
  agent_name: string | null;
  quantity: string;
  mark: string | null;
  unrealized_pnl: string | null;
}

export function DashboardPaperPositions({
  positions,
  loading,
}: {
  positions: PaperPosition[] | undefined;
  loading: boolean;
}) {
  return (
    <section
      className="platform-product-panel dashboard-paper-positions"
      aria-labelledby="dashboard-paper-portfolio"
    >
      <div className="dashboard-panel-heading">
        <h2 id="dashboard-paper-portfolio">
          <FlaskConical size={17} aria-hidden /> Paper trading portfolio
        </h2>
        <a href={workspaceHref("portfolio")}>View portfolio</a>
      </div>
      {!positions ? (
        <p className="dashboard-empty">
          {loading
            ? "Loading paper positions…"
            : "Paper positions are unavailable."}
        </p>
      ) : positions.length === 0 ? (
        <p className="dashboard-empty">
          No open paper positions. Filled buys appear here with their agent or
          manual source.
        </p>
      ) : (
        <div
          className="platform-backtest-table dashboard-position-table"
          role="region"
          aria-label="Open paper positions"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Source</th>
                <th>Quantity</th>
                <th>Marked value</th>
                <th>Unrealized P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={`${position.asset}:${position.agent_id ?? "manual"}`}>
                  <th scope="row">{position.asset}</th>
                  <td>
                    {position.agent_id ? (
                      <a
                        href={workspaceHref(
                          "agents",
                          `?agent=${position.agent_id}`,
                        )}
                      >
                        {position.agent_name ?? "Paper agent"}
                      </a>
                    ) : (
                      "Manual"
                    )}
                  </td>
                  <td>{number(position.quantity, 12)}</td>
                  <td>
                    {position.mark === null
                      ? "Awaiting price"
                      : money(position.mark)}
                  </td>
                  <td>{money(position.unrealized_pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function DashboardLivePortfolio({ enabled }: { enabled: boolean }) {
  return (
    <section
      className="platform-product-panel dashboard-live-portfolio"
      aria-labelledby="dashboard-live-portfolio"
    >
      <div className="dashboard-panel-heading">
        <h2 id="dashboard-live-portfolio">
          <Wallet size={17} aria-hidden /> Live trading portfolio
        </h2>
        <span className="dashboard-live-status">
          {enabled ? "Disconnected" : "Disabled"}
        </span>
      </div>
      <p className="dashboard-empty">
        Live positions require a verified account connection.
      </p>
    </section>
  );
}

type EquityMark = { at: string; equity: string };
const periods = {
  latest: "Latest marks",
  day: "Past 24 hours",
  week: "Past 7 days",
} as const;

const equityAxis = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

export function PortfolioPerformance({ rows }: { rows: EquityMark[] }) {
  const [period, setPeriod] = useState<keyof typeof periods>("latest");
  const [selectedAt, setSelectedAt] = useState<string>();
  const cutoff = Date.now() - (period === "day" ? 1 : 7) * 86400000;
  const marks =
    period === "latest"
      ? rows.slice(-60)
      : rows.filter((row) => Date.parse(row.at) >= cutoff);
  const match = marks.findIndex((row) => row.at === selectedAt);
  const selectedIndex = match >= 0 ? match : marks.length - 1;
  const selected = marks[selectedIndex];
  const first = Number(marks[0]?.equity);
  const last = Number(marks.at(-1)?.equity);
  const change = marks.length > 1 && first > 0 ? (last - first) / first : null;

  return (
    <section className="platform-product-panel dashboard-performance">
      <div className="dashboard-panel-heading">
        <h3>
          <ChartNoAxesColumn size={17} aria-hidden /> Portfolio performance
        </h3>
        <select
          aria-label="Equity period"
          value={period}
          onChange={(event) => {
            setPeriod(event.target.value as keyof typeof periods);
            setSelectedAt(undefined);
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
        <>
          <div className="dashboard-equity-reading">
            <div>
              <p>Recorded paper equity</p>
              <strong>{money(selected.equity)}</strong>
              <time dateTime={selected.at}>{timestamp(selected.at)}</time>
            </div>
            {change !== null && (
              <div className="dashboard-equity-change">
                {change === 0 ? (
                  <span>{percent(change)}</span>
                ) : (
                  <Delta value={change} />
                )}
                <small>Period change</small>
              </div>
            )}
          </div>
          <EquityChart
            rows={marks}
            baseline={first}
            padding={Math.max(1, Math.abs(first) * 0.005)}
            format={equityAxis.format}
            label="Recorded paper equity"
            area
            selectedIndex={selectedIndex}
          />
          {marks.length > 1 && (
            <input
              className="dashboard-equity-slider"
              type="range"
              min={0}
              max={marks.length - 1}
              value={selectedIndex}
              aria-label="Inspect equity snapshot"
              aria-valuetext={`${money(selected.equity)} at ${timestamp(selected.at)}`}
              onChange={(event) =>
                setSelectedAt(marks[Number(event.target.value)].at)
              }
            />
          )}
        </>
      ) : (
        <p className="dashboard-empty">No equity marks in this period.</p>
      )}
    </section>
  );
}

const allocationColors: Record<string, string> = {
  BTC: "var(--allocation-btc)",
  ETH: "var(--allocation-eth)",
  SOL: "var(--allocation-sol)",
};

export function AssetAllocation({
  cash,
  currency,
  equity,
  holdings,
}: {
  cash: string;
  currency: string;
  equity: string | null;
  holdings: {
    asset: string;
    quantity: string;
    mark: string | null;
    allocation: string | null;
  }[];
}) {
  const complete =
    equity !== null &&
    holdings.every((item) => item.allocation !== null && item.mark !== null);
  const total = Number(equity);
  const slices =
    complete && total > 0
      ? [
          {
            name: `Virtual ${currency}`,
            value: cash,
            share: Number(cash) / total,
            color: "var(--allocation-cash)",
            quantity: null,
          },
          ...holdings.map((item) => ({
            name: item.asset,
            value: item.mark,
            quantity: item.quantity,
            share: Number(item.allocation),
            color: allocationColors[item.asset] ?? "var(--allocation-sol)",
          })),
        ].filter((slice) => slice.share > 0)
      : [];
  let angle = 0;
  const stops = slices.map(({ share, color }) => {
    const start = angle;
    angle = Math.min(360, angle + share * 360);
    return `${color} ${start}deg ${angle}deg`;
  });

  return (
    <section className="platform-product-panel dashboard-allocation">
      <div className="dashboard-panel-heading">
        <h3>
          <PieChart size={17} aria-hidden /> Asset allocation
        </h3>
        <a href={workspaceHref("portfolio")}>Portfolio</a>
      </div>
      {slices.length ? (
        <div className="dashboard-allocation-content">
          <div
            className="dashboard-allocation-ring"
            style={
              {
                "--allocation-fill": `conic-gradient(${stops.join(", ")}, transparent ${angle}deg 360deg)`,
              } as CSSProperties
            }
            aria-hidden="true"
          >
            <div>
              <strong>{equityAxis.format(total)}</strong>
              <small>Paper equity</small>
            </div>
          </div>
          <dl className="dashboard-allocation-legend">
            {slices.map(({ name, share, value, color, quantity }) => (
              <div key={name}>
                <dt>
                  <span
                    className="dashboard-allocation-swatch"
                    style={{ background: color }}
                  />
                  {name}
                </dt>
                <dd>{percent(share, 1)}</dd>
                <dd>
                  {money(value)}
                  {quantity && ` · ${quantity} ${name}`}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <p className="dashboard-empty">
          {complete
            ? "No portfolio value to allocate."
            : "Allocation requires fresh prices for every holding."}
        </p>
      )}
    </section>
  );
}

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
