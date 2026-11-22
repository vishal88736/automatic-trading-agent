import { useEffect, useState, type FormEvent } from "react";
import { Plug, Rocket, Square } from "lucide-react";
import { money, number, timestamp } from "../ui";
import { platform } from "./client";
import { exchangeNames, type Connection, type LiveOrder } from "./LiveTrading";
import { workspaceHref } from "./navigation";

export interface AgentLiveState {
  id: string;
  status: string;
  stage: string;
  capital: string;
  live_connection_id: string | null;
  live_budget: string | null;
  live_since: string | null;
  live_label: string | null;
  live_exchange: keyof typeof exchangeNames | null;
  live_environment: "testnet" | "live" | null;
  live_status: "ACTIVE" | "PAUSED" | null;
  live_orders: number;
  live_spent: string;
  live_received: string;
}

export function AgentLive({
  agent,
  onChanged,
}: {
  agent: AgentLiveState;
  onChanged: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>();
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [selected, setSelected] = useState("");
  const [budget, setBudget] = useState("100");
  const [confirm, setConfirm] = useState(false);
  const [closePosition, setClosePosition] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = Boolean(agent.live_connection_id);

  useEffect(() => {
    let active = true;
    if (live) {
      const load = () =>
        platform<{ items: LiveOrder[] }>(
          `/paper-agents/${agent.id}/live/orders`,
        )
          .then(({ items }) => active && setOrders(items))
          .catch(() => undefined);
      void load();
      const timer = setInterval(load, 10000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }
    platform<{ items: Connection[] }>("/live/connections")
      .then(({ items }) => {
        if (!active) return;
        setConnections(items);
        setSelected((current) => current || items[0]?.id || "");
      })
      .catch(() => active && setConnections([]));
    return () => {
      active = false;
    };
  }, [agent.id, live]);

  const connection = connections?.find((item) => item.id === selected);
  const realFunds = connection?.environment === "live";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function promote(event: FormEvent) {
    event.preventDefault();
    void run(() =>
      platform(`/paper-agents/${agent.id}/live`, "POST", {
        connection_id: selected,
        budget_usdt: Number(budget).toFixed(2),
        acknowledge_live: realFunds && confirm,
      }),
    );
  }

  if (live)
    return (
      <section className="kx-agent-live" data-live>
        <header>
          <h3>
            <Plug size={16} aria-hidden /> Trading live on {agent.live_label}
          </h3>
          <span
            className="kx-badge"
            data-tone={agent.live_environment === "live" ? "warning" : "accent"}
          >
            {agent.live_exchange ? exchangeNames[agent.live_exchange] : ""} ·{" "}
            {agent.live_environment === "live" ? "Real funds" : "Testnet"}
          </span>
        </header>
        {agent.live_status === "PAUSED" && (
          <p className="kx-callout" data-tone="warning">
            The connection's kill switch is on, so new fills are skipped.
          </p>
        )}
        <dl className="kx-mini-stats">
          <div>
            <dt>Live budget</dt>
            <dd className="kx-num">{money(agent.live_budget)}</dd>
          </div>
          <div>
            <dt>Live orders</dt>
            <dd className="kx-num">{agent.live_orders}</dd>
          </div>
          <div>
            <dt>Bought / sold</dt>
            <dd className="kx-num">
              {money(agent.live_spent, 0)} / {money(agent.live_received, 0)}
            </dd>
          </div>
        </dl>
        <p className="muted">
          Each paper fill since {timestamp(agent.live_since)} is copied to the
          exchange, scaled from {money(agent.capital, 0)} paper capital to the
          live budget.
        </p>
        {orders.length > 0 && (
          <ol className="kx-feed">
            {orders.slice(0, 8).map((order) => (
              <li key={order.id}>
                <span
                  className="kx-side"
                  data-side={
                    order.status === "SKIPPED" || order.status === "REJECTED"
                      ? "info"
                      : order.side.toLowerCase()
                  }
                >
                  {order.side}
                </span>
                <span className="kx-feed-text">
                  {order.status === "FILLED"
                    ? `${number(order.executed_qty, 8)} ${order.asset} at ${money(order.average_price)}`
                    : `${order.status.toLowerCase()}${order.error ? ` · ${order.error}` : ""}`}
                </span>
                <time dateTime={order.created_at}>
                  {timestamp(order.created_at)}
                </time>
              </li>
            ))}
          </ol>
        )}
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        <div className="kx-actions">
          <label className="kx-check kx-check-plain">
            <input
              type="checkbox"
              checked={closePosition}
              onChange={(event) => setClosePosition(event.target.checked)}
            />
            Sell the live position when stopping
          </label>
          <button
            className="danger"
            disabled={busy}
            onClick={() =>
              void run(() =>
                platform(`/paper-agents/${agent.id}/live/stop`, "POST", {
                  close_position: closePosition,
                }),
              )
            }
          >
            <Square size={14} /> Stop live trading
          </button>
        </div>
      </section>
    );

  const eligible = agent.status === "RUNNING" && agent.stage === "MONITOR";
  return (
    <section className="kx-agent-live">
      <header>
        <h3>
          <Rocket size={16} aria-hidden /> Take this agent live
        </h3>
      </header>
      <p className="muted">
        The agent keeps trading on paper. Every new paper fill is also placed on
        your exchange account, scaled to the budget you choose.
      </p>
      {!eligible && (
        <p className="kx-callout">
          Available once the agent is running and has passed its validation
          replay.
        </p>
      )}
      {connections && connections.length === 0 && (
        <p className="kx-callout">
          <a href={workspaceHref("live")}>Link an exchange account</a> first.
          Start with a free testnet.
        </p>
      )}
      {eligible && connections && connections.length > 0 && (
        <form className="kx-promote" onSubmit={promote}>
          <label>
            Exchange account
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} ({exchangeNames[item.exchange]}{" "}
                  {item.environment === "live" ? "live" : "testnet"})
                </option>
              ))}
            </select>
          </label>
          <label>
            Live budget (USDT)
            <input
              type="number"
              min="10"
              max="100000"
              step="0.01"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </label>
          {realFunds && (
            <label className="kx-check">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(event) => setConfirm(event.target.checked)}
              />
              This agent will trade real funds. Agents need 7 days on paper
              first.
            </label>
          )}
          {error && (
            <p className="platform-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="primary"
            disabled={busy || !selected || (realFunds && !confirm)}
          >
            <Rocket size={15} /> Go live
          </button>
        </form>
      )}
    </section>
  );
}
