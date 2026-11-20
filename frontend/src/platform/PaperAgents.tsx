import { useEffect, useRef, useState, type FormEvent } from "react";
import { money, timestamp } from "../ui";
import { platform } from "./client";

type AgentStatus = "RUNNING" | "PAUSED" | "STOPPED" | "FAILED";
interface Agent {
  id: string;
  name: string;
  asset: string;
  strategy_version: number;
  report_id: string;
  capital: string;
  value: string | null;
  realized_pnl: string;
  unrealized_pnl: string | null;
  fills: number;
  status: AgentStatus;
  stage: "VALIDATE" | "MONITOR";
  heartbeat: string | null;
  next_run: string;
  worker_overdue: boolean;
  failures: number;
}
interface TimelineEvent {
  seq: number;
  occurred_at: string;
  kind: string;
  detail: Record<string, unknown>;
}

function eventText(entry: TimelineEvent) {
  const { detail } = entry;
  if (entry.kind === "DECISION") {
    return [
      detail.decision,
      detail.reason,
      detail.order_status,
      detail.order_reason,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (entry.kind === "VALIDATION") {
    return detail.approved
      ? `Replay approved · ${detail.holdout_trades} closed holdout trades`
      : `Replay rejected · ${(detail.reasons as string[]).join(", ")}`;
  }
  if (entry.kind === "QUEUED")
    return `Strategy v${detail.version} queued for validation`;
  if (entry.kind === "RETRY")
    return `Retry ${detail.attempt} · ${detail.error}`;
  if (entry.kind === "RECOVERED")
    return `Recovered checkpoint · ${detail.stage}`;
  return String(detail.reason ?? detail.action ?? detail.error ?? entry.kind);
}

export default function PaperAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [account, setAccount] = useState<{ epoch: number } | null>();
  const [selected, setSelected] = useState("");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedError, setFeedError] = useState("");
  const retry = useRef<{ input: string; key: string } | null>(null);
  const report =
    new URLSearchParams(location.hash.split("?")[1] ?? "").get("report") ?? "";
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [{ items }, wallet] = await Promise.all([
          platform<{ items: Agent[] }>("/paper-agents"),
          platform<{ account: { epoch: number } | null }>("/paper-account"),
        ]);
        if (!active) return;
        setAgents(items);
        setAccount(wallet.account);
        setSelected((current) => current || items[0]?.id || "");
        setFeedError("");
      } catch (err) {
        if (active) setFeedError((err as Error).message);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    setEvents([]);
    if (!selected) return;
    let active = true;
    async function refresh() {
      try {
        const { items } = await platform<{ items: TimelineEvent[] }>(
          `/paper-agents/${selected}/events`,
        );
        if (active) setEvents(items);
      } catch {
        if (active) setEvents([]);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setAgents((await platform<{ items: Agent[] }>("/paper-agents")).items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;
    const form = new FormData(event.currentTarget);
    const payload = {
      epoch: account.epoch,
      name: form.get("name"),
      report_id: form.get("report"),
      capital: form.get("capital"),
      interval_seconds: Number(form.get("interval")),
      max_drawdown: form.get("drawdown"),
      max_daily_loss: form.get("loss"),
    };
    const input = JSON.stringify(payload);
    if (retry.current?.input !== input)
      retry.current = { input, key: crypto.randomUUID() };
    const key = retry.current.key;
    void act(async () => {
      const { id } = await platform<{ id: string }>("/paper-agents", "POST", {
        ...payload,
        request_key: key,
      });
      retry.current = null;
      setSelected(id);
    });
  }

  const agent = agents.find((item) => item.id === selected);
  const lastDecision = events.find((entry) => entry.kind === "DECISION");
  return (
    <div className="platform-backtest">
      <section className="platform-product-panel">
        <h3>Start a paper agent</h3>
        <p>
          Choose a saved backtest report. The worker reviews the pinned strategy
          version and can continue when you sign out or close the browser.
        </p>
        {account === null && (
          <p>
            <a href="#/platform/paper">Open a paper account</a> before starting
            an agent.
          </p>
        )}
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        {feedError && (
          <p className="platform-error" role="alert">
            {feedError}
          </p>
        )}
        <form onSubmit={start}>
          <div className="platform-backtest-fields">
            <label>
              Agent name
              <input name="name" maxLength={120} required />
            </label>
            <label>
              Backtest report ID
              <input name="report" defaultValue={report} required />
            </label>
            <label>
              Allocated virtual USDT
              <input
                name="capital"
                type="number"
                min="0.01"
                step="0.01"
                defaultValue="1000"
                required
              />
            </label>
            <label>
              Evaluation interval (seconds)
              <input
                name="interval"
                type="number"
                min="10"
                max="3600"
                defaultValue="60"
                required
              />
            </label>
            <label>
              Drawdown cap (fraction)
              <input
                name="drawdown"
                type="number"
                min="0.001"
                max="0.10"
                step="0.001"
                defaultValue="0.10"
                required
              />
            </label>
            <label>
              Daily loss cap (fraction)
              <input
                name="loss"
                type="number"
                min="0.001"
                max="0.03"
                step="0.001"
                defaultValue="0.03"
                required
              />
            </label>
          </div>
          <button className="primary" disabled={busy || !account}>
            Start agent
          </button>
        </form>
      </section>
      {agents.length > 0 && (
        <section className="platform-product-panel">
          <h3>Paper agents</h3>
          <label htmlFor="selected-paper-agent">Agent</label>
          <select
            id="selected-paper-agent"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            {agents.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {agent && (
            <>
              <h4>
                {agent.name} · {agent.asset}/USD · Paper
              </h4>
              <p role="status">
                {agent.worker_overdue ||
                (agent.failures && agent.status === "RUNNING")
                  ? "Recovering"
                  : agent.status}{" "}
                · {agent.stage}
              </p>
              <dl className="platform-backtest-metrics">
                <div>
                  <dt>Capital</dt>
                  <dd>{money(agent.capital)}</dd>
                </div>
                <div>
                  <dt>Tracked value</dt>
                  <dd>{money(agent.value)}</dd>
                </div>
                <div>
                  <dt>Realized P&amp;L</dt>
                  <dd>{money(agent.realized_pnl)}</dd>
                </div>
                <div>
                  <dt>Unrealized P&amp;L</dt>
                  <dd>{money(agent.unrealized_pnl)}</dd>
                </div>
                <div>
                  <dt>Fills</dt>
                  <dd>{agent.fills}</dd>
                </div>
                <div>
                  <dt>Heartbeat</dt>
                  <dd>{timestamp(agent.heartbeat)}</dd>
                </div>
                <div>
                  <dt>Next evaluation</dt>
                  <dd>
                    {agent.status === "RUNNING"
                      ? timestamp(agent.next_run)
                      : "—"}
                  </dd>
                </div>
              </dl>
              <p>
                <a href={`#/platform/backtests/${agent.report_id}`}>
                  Backtest for strategy v{agent.strategy_version}
                </a>
              </p>
              {lastDecision && <p>Last decision · {eventText(lastDecision)}</p>}
              <div className="platform-product-actions">
                {(["pause", "resume", "stop"] as const).map((action) => (
                  <button
                    key={action}
                    disabled={
                      busy ||
                      (action === "pause"
                        ? agent.status !== "RUNNING"
                        : action === "resume"
                          ? agent.status !== "PAUSED"
                          : agent.status === "STOPPED")
                    }
                    onClick={() =>
                      void act(async () => {
                        await platform(
                          `/paper-agents/${agent.id}/control`,
                          "POST",
                          { action },
                        );
                      })
                    }
                  >
                    {action[0].toUpperCase() + action.slice(1)} agent
                  </button>
                ))}
              </div>
              <h4>Activity timeline</h4>
              {events.length ? (
                <ul>
                  {events.map((entry) => (
                    <li key={entry.seq}>
                      <time dateTime={entry.occurred_at}>
                        {timestamp(entry.occurred_at)}
                      </time>{" "}
                      · {eventText(entry)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No activity yet.</p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
