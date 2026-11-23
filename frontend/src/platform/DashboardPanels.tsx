import { useEffect, useState } from "react";
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
  const [state, setState] = useState<{
    configured: boolean;
    label?: string;
    environment?: string;
    status?: string;
    total?: string;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const { items, configured } = await platform<{
          configured: boolean;
          items: {
            id: string;
            label: string;
            environment: string;
            status: string;
          }[];
        }>("/live/connections");
        const first = items[0];
        if (!first) return active && setState({ configured });
        const account = await platform<{ total_value: string }>(
          `/live/connections/${first.id}/account`,
        ).catch((err: Error) => ({
          total_value: undefined,
          error: err.message,
        }));
        if (active)
          setState({
            configured,
            label: first.label,
            environment: first.environment,
            status: first.status,
            total: account.total_value,
            error: "error" in account ? account.error : undefined,
          });
      } catch {
        if (active) setState({ configured: false });
      }
    }
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const connected = Boolean(state?.label);
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
          {connected
            ? state?.environment === "live"
              ? "Live"
              : "Testnet"
            : enabled || state?.configured
              ? "Not linked"
              : "Disabled"}
        </span>
      </div>
      {connected ? (
        <a className="dashboard-live-total" href={workspaceHref("live")}>
          <small>{state?.label}</small>
          <strong className="kx-num">{money(state?.total)}</strong>
          {state?.error && <small>{state.error}</small>}
          {state?.status === "PAUSED" && <small>Trading paused</small>}
        </a>
      ) : (
        <p className="dashboard-empty">
          {state?.configured ? (
            <>
              <a className="kx-link" href={workspaceHref("live")}>
                Link an exchange account
              </a>{" "}
              to see live balances here.
            </>
          ) : (
            "Live positions require a verified account connection."
          )}
        </p>
      )}
    </section>
  );
}

export interface PaperPortfolioMark {
  at: string;
  equity: string;
  available_cash?: string | null;
  unrealized_pnl?: string | null;
  realized_pnl?: string | null;
  daily_pnl?: string | null;
  drawdown?: string | null;
}

const metricLabels = {
  equity: "Portfolio value",
  available_cash: "Buying power",
  unrealized_pnl: "Unrealized P&L",
  realized_pnl: "Realized P&L",
  daily_pnl: "Daily P&L",
  drawdown: "Drawdown",
} satisfies Record<keyof Omit<PaperPortfolioMark, "at">, string>;

export function DashboardMetric({
  metric,
  value,
  rows,
}: {
  metric: keyof typeof metricLabels;
  value: string | null;
  rows: PaperPortfolioMark[];
}) {
  const recorded = rows
    .flatMap((row) => {
      const mark = row[metric];
      return mark != null && Number.isFinite(Number(mark))
        ? [Number(mark)]
        : [];
    })
    .slice(-60);
  const ready = value !== null && recorded.length > 1;
  const change = (recorded.at(-1) ?? 0) - (recorded[0] ?? 0);
  const drawdown = metric === "drawdown";
  const relative =
    (metric === "equity" || metric === "available_cash") && recorded[0] > 0;
  const magnitude = Math.abs(change);
  const changeText = drawdown
    ? `${(magnitude * 100).toFixed(2)} pp`
    : relative
      ? percent(magnitude / recorded[0])
      : money(magnitude);
  const signedChange = `${change > 0 ? "+" : change < 0 ? "−" : ""}${changeText}`;
  const tone =
    !ready || change === 0
      ? "flat"
      : (drawdown ? change < 0 : change > 0)
        ? "up"
        : "down";
  return (
    <div className="dashboard-metric">
      <dt>{metricLabels[metric]}</dt>
      <dd
        className="dashboard-metric-value"
        data-sign={
          metric.endsWith("_pnl") ? Math.sign(Number(value)) : undefined
        }
      >
        {drawdown ? percent(value) : money(value)}
      </dd>
      <dd className="dashboard-metric-history">
        <span
          className="dashboard-trend"
          data-direction={tone}
          title={
            ready
              ? "Change across recorded snapshots"
              : "Trend requires two recorded values"
          }
          aria-label={
            ready ? `Recorded change ${signedChange}` : "Trend unavailable"
          }
        >
          {ready ? signedChange : "—"}
        </span>
        <span className="dashboard-metric-line">
          {ready && (
            <Sparkline
              values={recorded}
              positive={tone === "up"}
              neutral={tone === "flat"}
              shaded
            />
          )}
        </span>
      </dd>
    </div>
  );
}

const periods = {
  day: { short: "1D", label: "Past 24 hours", days: 1 },
  week: { short: "7D", label: "Past 7 days", days: 7 },
  month: { short: "1M", label: "Past 30 days", days: 30 },
  all: { short: "All", label: "All available marks", days: null },
} as const;

const equityAxis = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

export function PortfolioPerformance({ rows }: { rows: PaperPortfolioMark[] }) {
  const [period, setPeriod] = useState<keyof typeof periods>("all");
  const [selectedAt, setSelectedAt] = useState<string>();
  const days = periods[period].days;
  const cutoff = days === null ? null : Date.now() - days * 86400000;
  const marks =
    cutoff === null ? rows : rows.filter((row) => Date.parse(row.at) >= cutoff);
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
        <div
          className="dashboard-periods"
          role="group"
          aria-label="Equity period"
        >
          {(Object.keys(periods) as (keyof typeof periods)[]).map((key) => (
            <button
              type="button"
              key={key}
              aria-label={periods[key].label}
              aria-pressed={period === key}
              onClick={() => {
                setPeriod(key);
                setSelectedAt(undefined);
              }}
            >
              {periods[key].short}
            </button>
          ))}
        </div>
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
            formatPoint={money}
            label="Recorded paper equity"
            area
            selectedIndex={selectedIndex}
            onInspect={(index) => setSelectedAt(marks[index].at)}
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
  const totalShare = slices.reduce((sum, slice) => sum + slice.share, 0);
  const largest = slices.reduce<(typeof slices)[number] | undefined>(
    (lead, slice) => (!lead || slice.share > lead.share ? slice : lead),
    undefined,
  );
  let offset = 0;
  return (
    <section className="platform-product-panel dashboard-allocation">
      <div className="dashboard-panel-heading">
        <h3>
          <PieChart size={17} aria-hidden /> Asset allocation
        </h3>
        <a href={workspaceHref("portfolio")}>Portfolio</a>
      </div>
      {largest ? (
        <div className="dashboard-allocation-content">
          <div className="dashboard-allocation-ring" aria-hidden="true">
            <svg viewBox="0 0 140 140" fill="none">
              <circle
                className="dashboard-allocation-track"
                cx="70"
                cy="70"
                r="58"
              />
              <g transform="rotate(-90 70 70)">
                {slices.map(({ name, share, color }) => {
                  const length = (100 * share) / totalShare;
                  const start = offset;
                  offset += length;
                  const gap = slices.length > 1 ? Math.min(2, length / 3) : 0;
                  return (
                    <circle
                      key={name}
                      className="dashboard-allocation-slice"
                      cx="70"
                      cy="70"
                      r="58"
                      pathLength="100"
                      stroke={color}
                      strokeDasharray={`${length - gap} ${100 - length + gap}`}
                      strokeDashoffset={-start}
                    />
                  );
                })}
              </g>
            </svg>
            <div className="dashboard-allocation-total">
              <strong>{percent(largest.share, 1)}</strong>
              <span>{largest.name}</span>
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
