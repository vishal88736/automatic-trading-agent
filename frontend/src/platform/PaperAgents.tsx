import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Bot,
  CalendarClock,
  ChartNoAxesColumn,
  HeartPulse,
  Pause,
  Play,
  Plus,
  Square,
  WandSparkles,
} from "lucide-react";
import { Coin, money, timestamp } from "../ui";
import { platform } from "./client";
import { workspaceHref } from "./navigation";
import { PaperAgentFields, paperAgentSettings } from "./PaperAgentFields";

type AgentStatus = "RUNNING" | "PAUSED" | "STOPPED" | "FAILED";
interface Agent {
  id: string;
  name: string;
  asset: string;
  strategy_version: number;
  report_id: string | null;
  next_review_at: string | null;
  capital: string;
  value: string | null;
  realized_pnl: string;
  unrealized_pnl: string | null;
  fills: number;
  epoch: number;
  open_quantity: string;
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
  if (entry.kind === "VALIDATION" || entry.kind === "REVALIDATION") {
    return detail.approved
      ? `Replay approved · ${detail.holdout_trades} closed holdout trades`
      : `Replay rejected · ${(detail.reasons as string[]).join(", ")}${detail.suggestion ? ` · ${detail.suggestion}` : ""}`;
  }
  if (entry.kind === "QUEUED")
    return `Strategy v${detail.version} queued for validation`;
  if (entry.kind === "RETRY")
    return `Retry ${detail.attempt} · ${detail.error}`;
  if (entry.kind === "RECOVERED")
    return `Recovered checkpoint · ${detail.stage}`;
  return String(detail.reason ?? detail.action ?? detail.error ?? entry.kind);
}

interface StrategyOption {
  id: string;
  version: number;
  document: { name: string; definition: { asset: string } };
}

export default function PaperAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [account, setAccount] = useState<{ epoch: number } | null>();
  const [selected, setSelected] = useState("");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedError, setFeedError] = useState("");
  const [workerOnline, setWorkerOnline] = useState<boolean>();
  const closeKeys = useRef(new Map<string, string>());
  const retry = useRef<{ input: string; key: string } | null>(null);
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const report = params.get("report") ?? "";
  const requestedAgent = params.get("agent");
  const [source, setSource] = useState(report ? "report" : "strategy");
  const [strategies, setStrategies] = useState<StrategyOption[]>([]);
  const [strategyError, setStrategyError] = useState("");

  useEffect(() => {
    if (source !== "strategy") return;
    let active = true;
    async function loadStrategies() {
      try {
        const loaded: StrategyOption[] = [];
        let after = "";
        do {
          const { items } = await platform<{ items: StrategyOption[] }>(
            "/custom-strategies?limit=100" + (after ? `&after=${after}` : ""),
          );
          loaded.push(...items);
          after = items.length === 100 ? items[99].id : "";
        } while (active && after);
        if (active) {
          setStrategies(loaded);
          setStrategyError("");
        }
      } catch (error) {
        if (active) setStrategyError((error as Error).message);
      }
    }
    void loadStrategies();
    return () => {
      active = false;
    };
  }, [source]);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [{ items, worker_online }, wallet] = await Promise.all([
          platform<{ items: Agent[]; worker_online: boolean }>("/paper-agents"),
          platform<{ account: { epoch: number } | null }>("/paper-account"),
        ]);
        if (!active) return;
        setAgents(items);
        setWorkerOnline(worker_online);
        setAccount(wallet.account);
        setSelected(
          (current) =>
            current ||
            items.find((item) => item.id === requestedAgent)?.id ||
            items[0]?.id ||
            "",
        );
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
  }, [requestedAgent]);
  useEffect(() => {
    setEvents([]);
    if (!selected) return;
    let active = true;
    let streaming = false;
    const endpoint = `/paper-agents/${selected}`;
    async function refresh() {
      if (streaming) return;
      try {
        const { items } = await platform<{ items: TimelineEvent[] }>(
          endpoint + "/events",
        );
        if (active && !streaming) setEvents(items);
      } catch {
        // Existing activity remains visible during a temporary outage.
      }
    }
    void refresh();
    const stream =
      typeof EventSource === "undefined"
        ? undefined
        : new EventSource("/platform" + endpoint + "/stream");
    if (stream) {
      stream.onopen = () => {
        streaming = true;
      };
      stream.onerror = () => {
        streaming = false;
        void refresh();
      };
      stream.onmessage = (message) => {
        const entry = JSON.parse(message.data) as TimelineEvent;
        if (active)
          setEvents((items) =>
            [entry, ...items.filter((item) => item.seq !== entry.seq)]
              .sort((a, b) => b.seq - a.seq)
              .slice(0, 100),
          );
      };
    }
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      stream?.close();
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
    const strategy = strategies.find(
      (item) => item.id === form.get("strategy"),
    );
    if (source === "strategy" && !strategy) return;
    const validation = strategy
      ? { strategy_id: strategy.id, strategy_version: strategy.version }
      : { report_id: form.get("report") };
    const payload = {
      ...validation,
      epoch: account.epoch,
      ...paperAgentSettings(form),
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
  const [formOpen, setFormOpen] = useState(Boolean(report));

  const startForm = (
    <form onSubmit={start} className="kx-agent-form">
      <div className="platform-backtest-fields">
        <label>
          Validation source
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="strategy">Backtest a saved strategy</option>
            <option value="report">Use a saved backtest report</option>
          </select>
        </label>
        {source === "report" ? (
          <label>
            Backtest report ID
            <input name="report" defaultValue={report} required />
          </label>
        ) : (
          <label>
            Saved strategy
            <select
              name="strategy"
              aria-label="Saved strategy"
              required
              defaultValue=""
            >
              <option value="">Choose a saved strategy version</option>
              {strategies.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.document.name} · {item.document.definition.asset} · v
                  {item.version}
                </option>
              ))}
            </select>
            {strategyError && <span role="alert">{strategyError}</span>}
            {!strategies.length && !strategyError && (
              <a href={workspaceHref("builder")}>Create a strategy first</a>
            )}
          </label>
        )}
        <PaperAgentFields />
      </div>
      <button className="primary" disabled={busy || !account}>
        <Play size={15} /> Start agent
      </button>
    </form>
  );

  return (
    <div className="kx-stack">
      {workerOnline === false && (
        <p className="kx-callout" data-tone="warning" role="status">
          The agents worker is offline. Agents resume from their checkpoint as
          soon as it is running again.
        </p>
      )}
      {account === null && (
        <p className="kx-callout">
          <a href={workspaceHref("paper")}>Open a paper account</a> before
          starting an agent.
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

      {agents.length === 0 ? (
        <section className="kx-card kx-empty">
          <Bot size={32} aria-hidden />
          <h2>No agents yet</h2>
          <p>
            The fastest way to start is to describe a strategy to the AI
            builder. You can also start an agent from a saved strategy below.
          </p>
          <div className="kx-actions">
            <a className="button primary" href={workspaceHref("builder")}>
              <WandSparkles size={15} /> Build with AI
            </a>
            <button
              type="button"
              className="secondary"
              onClick={() => setFormOpen(true)}
            >
              Start from a saved strategy
            </button>
          </div>
        </section>
      ) : (
        <div className="kx-agents">
          <aside className="kx-agent-list" aria-label="Your agents">
            {agents.map((item) => {
              const value = item.value === null ? null : Number(item.value);
              const change =
                value === null ? null : value / Number(item.capital) - 1;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="kx-agent-item"
                  data-agent-id={item.id}
                  aria-pressed={item.id === selected}
                  onClick={() => setSelected(item.id)}
                >
                  <Coin symbol={item.asset} />
                  <span className="kx-agent-item-body">
                    <strong>{item.name}</strong>
                    <small>
                      <span className="kx-status" data-status={item.status}>
                        {item.status.toLowerCase()}
                      </span>{" "}
                      {money(item.capital, 0)}
                    </small>
                  </span>
                  {change !== null && (
                    <span
                      className="kx-num kx-change"
                      data-direction={change > 0 ? "up" : change < 0 ? "down" : "flat"}
                    >
                      {change >= 0 ? "+" : ""}
                      {(change * 100).toFixed(2)}%
                    </span>
                  )}
                </button>
              );
            })}
            <button
              type="button"
              className="kx-agent-add"
              onClick={() => setFormOpen(!formOpen)}
              aria-expanded={formOpen}
            >
              <Plus size={16} /> New agent from strategy
            </button>
          </aside>

          {agent && (
            <section className="kx-card kx-agent-detail">
              <header className="kx-agent-head">
                <div>
                  <h2>
                    <Coin symbol={agent.asset} /> {agent.name}
                  </h2>
                  <p className="muted">
                    {agent.asset}/USD · Strategy v{agent.strategy_version} ·
                    Paper
                  </p>
                </div>
                <span
                  className="kx-status kx-status-lg"
                  data-status={
                    agent.worker_overdue ||
                    (agent.failures && agent.status === "RUNNING")
                      ? "RECOVERING"
                      : agent.status
                  }
                  role="status"
                >
                  {agent.worker_overdue ||
                  (agent.failures && agent.status === "RUNNING")
                    ? "Recovering"
                    : agent.status === "RUNNING" && agent.stage === "VALIDATE"
                      ? "Validating"
                      : agent.status.toLowerCase()}
                </span>
              </header>

              <dl className="kx-stat-grid">
                <div>
                  <dt>Allocation</dt>
                  <dd className="kx-num">{money(agent.capital)}</dd>
                </div>
                <div>
                  <dt>Current value</dt>
                  <dd className="kx-num">{money(agent.value)}</dd>
                </div>
                <div>
                  <dt>Realized P&amp;L</dt>
                  <dd
                    className="kx-num"
                    data-direction={Number(agent.realized_pnl) >= 0 ? "up" : "down"}
                  >
                    {money(agent.realized_pnl)}
                  </dd>
                </div>
                <div>
                  <dt>Unrealized P&amp;L</dt>
                  <dd
                    className="kx-num"
                    data-direction={
                      Number(agent.unrealized_pnl ?? 0) >= 0 ? "up" : "down"
                    }
                  >
                    {money(agent.unrealized_pnl)}
                  </dd>
                </div>
                <div>
                  <dt>Trades</dt>
                  <dd className="kx-num">{agent.fills}</dd>
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

              <div className="kx-agent-meta">
                <span>
                  <HeartPulse size={14} aria-hidden /> Heartbeat{" "}
                  {timestamp(agent.heartbeat)}
                </span>
                {agent.status === "RUNNING" && agent.next_review_at && (
                  <span>
                    <CalendarClock size={14} aria-hidden /> Strategy review{" "}
                    {timestamp(agent.next_review_at)}
                  </span>
                )}
                {agent.report_id && (
                  <a href={workspaceHref("backtests", `/${agent.report_id}`)}>
                    <ChartNoAxesColumn size={14} aria-hidden /> Validation
                    backtest
                  </a>
                )}
              </div>
              {lastDecision && (
                <p className="kx-callout">
                  Last decision: {eventText(lastDecision)}
                </p>
              )}

              <div className="kx-actions">
                {(["pause", "resume", "stop"] as const).map((action) => {
                  const Icon =
                    action === "pause" ? Pause : action === "resume" ? Play : Square;
                  return (
                    <button
                      key={action}
                      className={action === "stop" ? "danger" : "secondary"}
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
                      <Icon size={14} />{" "}
                      {action[0].toUpperCase() + action.slice(1)} agent
                    </button>
                  );
                })}
                {agent.status !== "RUNNING" &&
                  agent.epoch === account?.epoch &&
                  Number(agent.open_quantity) > 0 && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const key =
                            closeKeys.current.get(agent.id) ??
                            crypto.randomUUID();
                          closeKeys.current.set(agent.id, key);
                          const result = await platform<{
                            status: string;
                            reason: string | null;
                          }>(`/paper-agents/${agent.id}/close-position`, "POST", {
                            request_key: key,
                            epoch: agent.epoch,
                          });
                          closeKeys.current.delete(agent.id);
                          if (result.status !== "FILLED")
                            throw Error(
                              `Close rejected · ${result.reason ?? result.status}`,
                            );
                        })
                      }
                    >
                      Close agent paper position
                    </button>
                  )}
              </div>

              <h3 className="kx-card-title">Live activity</h3>
              {events.length ? (
                <ol className="kx-feed">
                  {events.map((entry) => {
                    const decision =
                      entry.kind === "DECISION"
                        ? String(entry.detail.decision ?? "")
                        : "";
                    return (
                      <li key={entry.seq}>
                        <span
                          className="kx-side"
                          data-side={
                            decision === "BUY"
                              ? "buy"
                              : decision === "SELL"
                                ? "sell"
                                : decision
                                  ? "hold"
                                  : "info"
                          }
                        >
                          {decision || entry.kind.toLowerCase()}
                        </span>
                        <span className="kx-feed-text">
                          {eventText(entry)}
                          {(entry.kind === "VALIDATION" ||
                            entry.kind === "REVALIDATION") &&
                            typeof entry.detail.report_id === "string" && (
                              <>
                                {" "}
                                ·{" "}
                                <a
                                  href={workspaceHref(
                                    "backtests",
                                    `/${entry.detail.report_id}`,
                                  )}
                                >
                                  View replay
                                </a>
                              </>
                            )}
                        </span>
                        <time dateTime={entry.occurred_at}>
                          {timestamp(entry.occurred_at)}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="muted">No activity yet.</p>
              )}
            </section>
          )}
        </div>
      )}

      {formOpen && (
        <section className="kx-card">
          <h2 className="kx-card-title">Start an agent from a saved strategy</h2>
          <p className="muted">
            The worker replays the pinned strategy on recent candles before any
            simulated order, and keeps running after you sign out or close the
            browser.
          </p>
          {startForm}
        </section>
      )}
    </div>
  );
}
