import { useEffect, useState } from "react";
import { Crown, Medal, RefreshCw, Trophy, WandSparkles } from "lucide-react";
import { Coin, money } from "../ui";
import { platform } from "./client";
import { workspaceHref } from "./navigation";

interface Entry {
  rank: number;
  id: string | null;
  mine: boolean;
  name: string;
  status: "RUNNING" | "PAUSED" | "STOPPED";
  stage: string;
  capital: string;
  created_at: string;
  strategy: string;
  asset: string;
  owner: string;
  fills: number;
  realized_pnl: string;
  equity: string;
  marked_at: string | null;
  max_drawdown: string;
  samples: number;
  return_pct: string;
}

const signed = (value: number, digits = 2) =>
  `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;

function age(from: string) {
  const hours = (Date.now() - new Date(from).getTime()) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function Return({ value }: { value: string }) {
  const n = Number(value);
  return (
    <span
      className="kx-num kx-change"
      data-direction={n > 0 ? "up" : n < 0 ? "down" : "flat"}
    >
      {signed(n)}
    </span>
  );
}

const podiumIcons = [Crown, Medal, Medal];

export default function Leaderboard() {
  const [scope, setScope] = useState<"active" | "all">("active");
  const [data, setData] = useState<{
    items: Entry[];
    worker_online: boolean;
  }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setData(
        await platform<{ items: Entry[]; worker_online: boolean }>(
          `/leaderboard?scope=${scope}`,
        ),
      );
      setError("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const items = data?.items ?? [];
  const mine = items.filter((item) => item.mine);
  const best = mine[0];
  const podium = items.slice(0, 3);

  return (
    <div className="kx-stack">
      <div className="kx-toolbar">
        <div className="kx-segmented" role="group" aria-label="Agents shown">
          {(["active", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {value === "active" ? "Running & paused" : "All time"}
            </button>
          ))}
        </div>
        <div className="kx-toolbar-end">
          {data && (
            <span className="kx-badge" data-tone={data.worker_online ? "positive" : "negative"}>
              <span className="kx-dot" aria-hidden />
              {data.worker_online ? "Live rankings" : "Worker offline"}
            </span>
          )}
          <button
            type="button"
            className="kx-icon-button"
            aria-label="Refresh leaderboard"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? "spin" : undefined} />
          </button>
        </div>
      </div>

      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}

      {data && items.length === 0 && (
        <section className="kx-card kx-empty">
          <Trophy size={32} aria-hidden />
          <h2>No agents on the board yet</h2>
          <p>
            Describe a strategy to the AI builder, start it as a paper agent,
            and it will appear here as soon as the worker marks its first
            evaluation.
          </p>
          <a className="button primary" href={workspaceHref("builder")}>
            <WandSparkles size={15} /> Build the first agent
          </a>
        </section>
      )}

      {podium.length > 0 && (
        <div className="kx-podium">
          {podium.map((entry, index) => {
            const Icon = podiumIcons[index]!;
            return (
              <article
                key={`${entry.rank}-${entry.name}`}
                className="kx-card kx-podium-card"
                data-place={index + 1}
                data-mine={entry.mine || undefined}
              >
                <header>
                  <span className="kx-place">
                    <Icon size={16} aria-hidden /> #{entry.rank}
                  </span>
                  {entry.mine && <span className="kx-pill">You</span>}
                </header>
                <h3>{entry.name}</h3>
                <p className="muted">
                  {entry.owner} · {entry.strategy}
                </p>
                <div className="kx-podium-return">
                  <Return value={entry.return_pct} />
                  <small>return on {money(entry.capital, 0)}</small>
                </div>
                <dl className="kx-mini-stats">
                  <div>
                    <dt>Equity</dt>
                    <dd className="kx-num">{money(entry.equity)}</dd>
                  </div>
                  <div>
                    <dt>Max DD</dt>
                    <dd className="kx-num">
                      {(Number(entry.max_drawdown) * 100).toFixed(2)}%
                    </dd>
                  </div>
                  <div>
                    <dt>Trades</dt>
                    <dd className="kx-num">{entry.fills}</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      )}

      {best && (
        <p className="kx-callout">
          Your best agent, <strong>{best.name}</strong>, is ranked{" "}
          <strong>#{best.rank}</strong> of {items.length}.
        </p>
      )}

      {items.length > 0 && (
        <section className="kx-card kx-table-card">
          <div className="kx-table-scroll">
            <table className="kx-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Agent</th>
                  <th>Trader</th>
                  <th>Market</th>
                  <th>Status</th>
                  <th className="num">Return</th>
                  <th className="num">Equity</th>
                  <th className="num">Max DD</th>
                  <th className="num">Trades</th>
                  <th className="num">Age</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={`${entry.rank}-${entry.name}`} data-mine={entry.mine || undefined}>
                    <td className="kx-rank">{entry.rank}</td>
                    <td>
                      {entry.mine && entry.id ? (
                        <a href={workspaceHref("agents", `?agent=${entry.id}`)}>
                          <strong>{entry.name}</strong>
                        </a>
                      ) : (
                        <strong>{entry.name}</strong>
                      )}
                      <small>{entry.strategy}</small>
                    </td>
                    <td>
                      {entry.owner}
                      {entry.mine && <span className="kx-pill">You</span>}
                    </td>
                    <td>
                      <span className="kx-asset">
                        <Coin symbol={entry.asset} /> {entry.asset}
                      </span>
                    </td>
                    <td>
                      <span className="kx-status" data-status={entry.status}>
                        {entry.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="num">
                      <Return value={entry.return_pct} />
                    </td>
                    <td className="num kx-num">{money(entry.equity)}</td>
                    <td className="num kx-num">
                      {(Number(entry.max_drawdown) * 100).toFixed(2)}%
                    </td>
                    <td className="num kx-num">{entry.fills}</td>
                    <td className="num kx-num">{age(entry.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="kx-footnote">
            Returns are marked by the server-side worker on live Coinbase
            prices, net of simulated fees and slippage. Paper results do not
            guarantee live performance.
          </p>
        </section>
      )}
    </div>
  );
}
