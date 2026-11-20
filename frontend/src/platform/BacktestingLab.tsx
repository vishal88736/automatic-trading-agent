import { useEffect, useState, type FormEvent } from "react";
import { CandleChart, EquityChart, type ChartViewport } from "../charts";
import type { Candle } from "../types";
import { money, percent, timestamp } from "../ui";
import { platform } from "./client";
import { workspaceHref } from "./navigation";

interface SavedStrategy {
  id: string;
  version: number;
  document: { name: string; definition: { asset: string } };
}
interface Fill {
  side: "BUY" | "SELL";
  at: string;
  price: string;
  quantity: string;
  fee: string;
  pnl?: string;
  reason?: string;
}
interface Segment {
  from: string;
  to: string;
  starting_equity: string;
  total_return: string;
  net_pnl: string;
  maximum_drawdown: string;
  benchmark_return: string;
  win_rate: string | null;
  profit_factor: string | null;
  sharpe_ratio: string | null;
  sortino_ratio: string | null;
  trade_count: number;
  average_trade_duration_seconds: string | null;
  average_win: string | null;
  average_loss: string | null;
  exposure: string;
  fees: string;
  equity_history: { at: string; equity: string; drawdown: string }[];
  trades: Fill[];
}
interface Report {
  id: string;
  strategy_version: number;
  engine_version: string;
  dataset: { sha256: string; source: string; candle_count: number };
  request: object;
  market_data: { candles: Candle[] };
  result: {
    fixture: boolean;
    symbol: string;
    in_sample: Segment;
    out_of_sample: Segment;
    assumptions: Record<string, string | number>;
    parameters: object;
  };
}
const layouts = ["in_sample", "out_of_sample"] as const;
const ratio = (value: string | null) =>
  value === null ? "—" : Number(value).toFixed(2);

function ReportView({ report }: { report: Report }) {
  const [sample, setSample] =
    useState<(typeof layouts)[number]>("out_of_sample");
  const [view, setView] = useState<ChartViewport>({ bars: 90, offset: 0 });
  const segment = report.result[sample];
  const candles = report.market_data.candles.filter(
    (candle) =>
      Date.parse(candle.timestamp) >= Date.parse(segment.from) &&
      Date.parse(candle.closed_at) <= Date.parse(segment.to),
  );
  const chartRows = segment.equity_history;
  const metrics = [
    ["Total return", percent(segment.total_return)],
    ["Net P&L", money(segment.net_pnl)],
    ["Max drawdown", percent(segment.maximum_drawdown)],
    ["Buy and hold", percent(segment.benchmark_return)],
    ["Win rate", percent(segment.win_rate)],
    ["Profit factor", ratio(segment.profit_factor)],
    ["Sharpe", ratio(segment.sharpe_ratio)],
    ["Sortino", ratio(segment.sortino_ratio)],
    ["Closed trades", segment.trade_count],
    [
      "Avg. duration",
      segment.average_trade_duration_seconds !== null
        ? `${(Number(segment.average_trade_duration_seconds) / 3600).toFixed(1)} h`
        : "—",
    ],
    ["Avg. win", money(segment.average_win)],
    ["Avg. loss", money(segment.average_loss)],
    ["Exposure", percent(segment.exposure)],
    ["Trading fees", money(segment.fees)],
  ];
  return (
    <section className="platform-product-panel">
      <h3>Replay report</h3>
      <a
        href={workspaceHref(
          "agents",
          `?report=${encodeURIComponent(report.id)}`,
        )}
      >
        Use report for a paper agent
      </a>
      <p>
        {report.result.symbol}/USD · hourly · strategy v
        {report.strategy_version} ·{" "}
        {report.result.fixture ? "Synthetic fixture" : "Coinbase Exchange"}
      </p>
      <p>
        Historical simulation. Results depend on the selected period and
        execution assumptions.
      </p>
      <div className="platform-product-actions" aria-label="Evaluation window">
        {layouts.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={sample === key}
            onClick={() => {
              setSample(key);
              setView({ bars: 90, offset: 0 });
            }}
          >
            {key === "in_sample" ? "In-sample" : "Holdout"}
          </button>
        ))}
      </div>
      <p>
        {timestamp(segment.from)} to {timestamp(segment.to)}
      </p>
      <dl className="platform-backtest-metrics">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <h4>Equity</h4>
      <EquityChart
        rows={chartRows}
        baseline={Number(segment.starting_equity)}
        label="Backtest equity"
      />
      <h4>Drawdown</h4>
      <EquityChart
        baseline={0}
        padding={0.0001}
        label="Backtest drawdown"
        format={(value) => percent(value, 1)}
        formatPoint={percent}
        rows={chartRows.map((row) => ({ at: row.at, equity: row.drawdown }))}
      />
      <h4>Price and simulated fills</h4>
      <CandleChart
        candles={candles}
        view={view}
        onViewChange={setView}
        markers={segment.trades.map((trade, index) => ({
          id: String(index),
          timestamp: trade.at,
          price: trade.price,
          side: trade.side,
          detail: trade.reason ?? "Strategy entry",
          label: trade.side,
        }))}
      />
      <h4>Fill history</h4>
      {segment.trades.length ? (
        <div className="platform-backtest-table">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Side</th>
                <th>Price</th>
                <th>Quantity</th>
                <th>Fee</th>
                <th>P&L</th>
              </tr>
            </thead>
            <tbody>
              {segment.trades.map((trade, index) => (
                <tr key={index}>
                  <td>{timestamp(trade.at)}</td>
                  <td>{trade.side}</td>
                  <td>{money(trade.price)}</td>
                  <td>{trade.quantity}</td>
                  <td>{money(trade.fee)}</td>
                  <td>{money(trade.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No fills in this window.</p>
      )}
      <details>
        <summary>Assumptions and dataset</summary>
        <p>
          {report.engine_version} · {report.dataset.source} ·{" "}
          {report.dataset.candle_count} candles
        </p>
        <p>
          SHA-256 <code>{report.dataset.sha256}</code>
        </p>
        <dl>
          {Object.entries(report.result.assumptions).map(([key, value]) => (
            <div key={key}>
              <dt>{key.replaceAll("_", " ")}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <pre>
          {JSON.stringify(
            { request: report.request, strategy: report.result.parameters },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}

export default function BacktestingLab({ reportId }: { reportId?: string }) {
  const [report, setReport] = useState<Report>();
  const [strategies, setStrategies] = useState<SavedStrategy[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const request = reportId
      ? platform<Report>(
          `/backtests/${encodeURIComponent(reportId)}?include_dataset=true`,
        ).then((data) => {
          if (active) setReport(data);
        })
      : platform<{ items: SavedStrategy[] }>(
          "/custom-strategies?limit=100",
        ).then(({ items }) => {
          if (active) setStrategies(items);
        });
    request
      .catch((err: Error) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [reportId]);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const chosen = strategies.find(
      (strategy) => strategy.id === fields.get("strategy"),
    );
    if (!chosen) return;
    const start = `${fields.get("start")}T00:00:00Z`;
    const end = `${fields.get("end")}T00:00:00Z`;
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (!Number.isFinite(days) || days < 4 || days > 14) {
      setError("Select a window of 4 to 14 UTC days.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await platform<{ id: string }>(
        `/custom-strategies/${chosen.id}/backtests`,
        "POST",
        {
          version: chosen.version,
          start,
          end,
          initial_equity: fields.get("capital"),
          fee_bps: Number(fields.get("fees")),
          slippage_bps: Number(fields.get("slippage")),
        },
      );
      window.location.hash = workspaceHref("backtests", `/${saved.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const finalizedDate = new Date().toISOString().slice(0, 10);
  return (
    <div className="platform-backtest">
      {reportId && <a href={workspaceHref("backtests")}>New backtest</a>}
      {error && (
        <p role="alert" className="platform-error">
          {error}
        </p>
      )}
      {busy && (
        <p role="status">
          {reportId
            ? "Loading saved report…"
            : "Loading strategy data or running replay…"}
        </p>
      )}
      {report ? (
        <ReportView report={report} />
      ) : (
        !reportId &&
        strategies.length > 0 && (
          <form
            className="platform-product-panel"
            onSubmit={(event) => void run(event)}
          >
            <h3>Historical replay</h3>
            <p>
              Coinbase Exchange spot · hourly bars · 4 to 14 days selected in
              UTC. Includes preceding warm-up history.
            </p>
            <div className="platform-backtest-fields">
              <div>
                <label htmlFor="backtest-strategy">Strategy</label>
                <select id="backtest-strategy" name="strategy" required>
                  {strategies.map((strategy) => (
                    <option value={strategy.id} key={strategy.id}>
                      {strategy.document.name} ·{" "}
                      {strategy.document.definition.asset}/USD · v
                      {strategy.version}
                    </option>
                  ))}
                </select>
              </div>
              <label>
                Start date
                <input name="start" type="date" max={finalizedDate} required />
              </label>
              <label>
                End date (exclusive)
                <input name="end" type="date" max={finalizedDate} required />
              </label>
              <label>
                Starting capital (USD)
                <input
                  name="capital"
                  type="number"
                  min="1"
                  max="100000000"
                  step="0.01"
                  defaultValue="10000"
                  required
                />
              </label>
              <label>
                Fee (bps)
                <input
                  name="fees"
                  type="number"
                  min="0"
                  max="30"
                  defaultValue="10"
                  required
                />
              </label>
              <label>
                Slippage (bps)
                <input
                  name="slippage"
                  type="number"
                  min="0"
                  max="50"
                  defaultValue="10"
                  required
                />
              </label>
            </div>
            <button type="submit" className="primary" disabled={busy}>
              Run backtest
            </button>
          </form>
        )
      )}
      {!reportId && !busy && !error && !strategies.length && (
        <p>
          Save a strategy in{" "}
          <a href={workspaceHref("strategies")}>Strategies</a> to run a
          backtest.
        </p>
      )}
    </div>
  );
}
