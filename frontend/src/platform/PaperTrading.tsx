import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { EquityChart } from "../charts";
import { money, percent, timestamp } from "../ui";
import { platform } from "./client";
import { legacyFixture, workspaceHref } from "./navigation";
import { PortfolioBars } from "./DashboardPanels";

interface Account {
  id: string;
  epoch: number;
  currency: string;
  cash: string;
}
interface Portfolio {
  epoch: number;
  available_cash: string;
  equity: string | null;
  realized_pnl: string;
  unrealized_pnl: string | null;
  daily_pnl: string | null;
  drawdown: string | null;
  emergency_stop: boolean;
  holdings: {
    asset: string;
    quantity: string;
    mark: string | null;
    unrealized_pnl: string | null;
    allocation: string | null;
  }[];
  history: { at: string; equity: string }[];
}
interface Order {
  id: string;
  epoch: number;
  agent_id?: string | null;
  status: string;
  reason: string | null;
  created_at: string;
  fill_price: string | null;
  fee: string | null;
  realized_pnl: string | null;
  request: {
    asset: string;
    side: string;
    quantity: string;
    limit_price: string | null;
  };
}
async function fetchPaper(includeOrders: boolean) {
  const { account } = await platform<{ account: Account | null }>(
    "/paper-account",
  );
  if (!account) return { account, value: null, orders: [] };
  const [value, { items }] = await Promise.all([
    platform<Portfolio>("/paper-portfolio"),
    includeOrders
      ? platform<{ items: Order[] }>("/paper-orders")
      : { items: [] },
  ]);
  return { account, value, orders: items };
}

export default function PaperAccount({
  view = "trade",
  dashboardSide,
  dashboardBottom,
}: {
  view?: "dashboard" | "portfolio" | "trade" | "settings";
  dashboardSide?: ReactNode;
  dashboardBottom?: ReactNode;
}) {
  const dashboard = view === "dashboard";
  const includeOrders = view !== "settings";
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchPaper>>>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [kind, setKind] = useState("market");
  const [confirmReset, setConfirmReset] = useState(false);
  const retry = useRef<{ input: string; key: string } | null>(null);
  useEffect(() => {
    let mounted = true;
    fetchPaper(includeOrders)
      .then((next) => {
        if (mounted) setData(next);
      })
      .catch((err: Error) => {
        if (mounted) setError(err.message);
      })
      .finally(() => {
        if (mounted) setBusy(false);
      });
    return () => {
      mounted = false;
    };
  }, [includeOrders]);

  async function act(action?: () => Promise<void>) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await action?.();
      setData(await fetchPaper(includeOrders));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const account = data?.account;
  const value = data?.value;
  const metrics = value && (
    <dl className="platform-backtest-metrics">
      <div>
        <dt>Buying power</dt>
        <dd>{money(value.available_cash)}</dd>
      </div>
      <div>
        <dt>Portfolio value</dt>
        <dd>{money(value.equity)}</dd>
      </div>
      <div>
        <dt>Realized P&amp;L</dt>
        <dd>{money(value.realized_pnl)}</dd>
      </div>
      <div>
        <dt>Unrealized P&amp;L</dt>
        <dd>{money(value.unrealized_pnl)}</dd>
      </div>
      <div>
        <dt>Daily P&amp;L</dt>
        <dd>{money(value.daily_pnl)}</dd>
      </div>
      <div>
        <dt>Drawdown</dt>
        <dd>{percent(value.drawdown)}</dd>
      </div>
    </dl>
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!account) return;
    const form = new FormData(event.currentTarget);
    const payload = {
      epoch: account.epoch,
      asset: form.get("asset"),
      side: form.get("side"),
      quantity: form.get("quantity"),
      limit_price: kind === "limit" ? form.get("limit") : null,
    };
    const input = JSON.stringify(payload);
    if (retry.current?.input !== input)
      retry.current = { input, key: crypto.randomUUID() };
    const requestKey = retry.current.key;
    void act(async () => {
      const order = await platform<Order>("/paper-orders", "POST", {
        ...payload,
        request_key: requestKey,
      });
      retry.current = null;
      setMessage(
        `Order ${order.status.toLowerCase()}${order.reason ? ` · ${order.reason.replaceAll("_", " ").toLowerCase()}` : ""}.`,
      );
    });
  }

  return (
    <div
      className={
        dashboard ? "platform-backtest paper-overview" : "platform-backtest"
      }
    >
      <section
        className="platform-product-panel paper-overview-balance"
        aria-labelledby="paper-balance"
      >
        <div className="paper-balance-heading">
          <div>
            <h3 id="paper-balance">Virtual balance</h3>
            {account && (
              <p className="platform-product-balance">
                <strong>{account.cash}</strong> virtual {account.currency}
              </p>
            )}
          </div>
          {(!data || account) && (
            <button disabled={busy} onClick={() => void act()}>
              Refresh account
            </button>
          )}
          {data && !account && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await platform("/paper-account", "POST");
                })
              }
            >
              Open virtual account
            </button>
          )}
        </div>
        <p className="paper-money-note">
          Simulated funds. USD market prices are modeled at 1 virtual USDT per
          USD.
        </p>
        {error && (
          <p role="alert" className="platform-error">
            {error}
          </p>
        )}
        <p role="status">{busy ? "Updating paper account…" : message}</p>
        {value && view !== "settings" && (
          <>
            {value.equity === null && (
              <p>
                Portfolio value is unavailable until all held assets have fresh
                prices.
              </p>
            )}
            {!dashboard && metrics}
            {dashboard && <PortfolioBars rows={value.history} />}
            {view === "portfolio" && value.history.length > 1 && (
              <EquityChart
                rows={value.history}
                baseline={Number(value.history[0].equity)}
                label="Paper portfolio equity"
              />
            )}
            <h4>Holdings</h4>
            {value.holdings.length ? (
              <ul>
                {value.holdings.map((item) => (
                  <li key={item.asset}>
                    {item.asset} · {item.quantity} · {money(item.mark)} marked
                    value · {percent(item.allocation)} allocation
                  </li>
                ))}
              </ul>
            ) : (
              <p>No open positions.</p>
            )}
          </>
        )}
      </section>
      {dashboard && (
        <aside className="dashboard-side">
          <section className="platform-product-panel dashboard-metrics">
            <div className="dashboard-panel-heading">
              <h3>Paper account</h3>
              <a href={workspaceHref("portfolio")}>Portfolio</a>
            </div>
            {metrics}
            {!value && <p>Account metrics are unavailable.</p>}
          </section>
          {dashboardSide}
        </aside>
      )}
      {account && value && view === "trade" && (
        <form className="platform-product-panel" onSubmit={submit}>
          <h3>Place a paper order</h3>
          <div className="platform-backtest-fields">
            <label>
              Asset
              <select name="asset">
                <option>BTC</option>
                <option>ETH</option>
                <option>SOL</option>
              </select>
            </label>
            <label>
              Side
              <select name="side">
                <option>BUY</option>
                <option>SELL</option>
              </select>
            </label>
            <label>
              Order type
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="market">Market</option>
                <option value="limit">Limit</option>
              </select>
            </label>
            <label>
              Quantity
              <input
                name="quantity"
                type="number"
                min="0.000000000001"
                step="0.000000000001"
                required
              />
            </label>
            {kind === "limit" && (
              <label>
                Limit price
                <input
                  name="limit"
                  type="number"
                  min="0.000000000001"
                  step="0.000000000001"
                  required
                />
              </label>
            )}
          </div>
          <button
            type="submit"
            className="primary"
            disabled={busy || value.emergency_stop}
          >
            Submit paper order
          </button>
        </form>
      )}
      {account && value && includeOrders && (
        <section className="platform-product-panel paper-overview-orders">
          <div className="dashboard-panel-heading">
            <h3>{dashboard ? "Recent paper orders" : "Order history"}</h3>
            {dashboard && <a href={workspaceHref("paper")}>Paper trading</a>}
          </div>
          {data.orders.length ? (
            <div className="platform-backtest-table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Order</th>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Fill</th>
                    <th>Fee</th>
                    <th>Realized P&amp;L</th>
                    {!dashboard && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {(dashboard ? data.orders.slice(0, 5) : data.orders).map(
                    (order) => (
                      <tr key={order.id}>
                        <td>{timestamp(order.created_at)}</td>
                        <td>
                          {order.request.side} {order.request.quantity}{" "}
                          {order.request.asset}
                          {order.request.limit_price &&
                            ` @ ${order.request.limit_price}`}{" "}
                          · Epoch {order.epoch}
                        </td>
                        <td>{order.agent_id ? "Agent" : "Manual"}</td>
                        <td>
                          <span
                            className="paper-order-status"
                            data-status={order.status}
                          >
                            {order.status}
                          </span>
                          {order.reason &&
                            ` · ${order.reason.replaceAll("_", " ")}`}
                        </td>
                        <td>{money(order.fill_price)}</td>
                        <td>{money(order.fee)}</td>
                        <td>{money(order.realized_pnl)}</td>
                        {!dashboard && (
                          <td>
                            {order.status === "OPEN" && (
                              <div className="platform-product-actions">
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void act(async () => {
                                      await platform(
                                        `/paper-orders/${order.id}/evaluate`,
                                        "POST",
                                      );
                                    })
                                  }
                                >
                                  Check limit
                                </button>
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void act(async () => {
                                      await platform(
                                        `/paper-orders/${order.id}/cancel`,
                                        "POST",
                                      );
                                    })
                                  }
                                >
                                  Cancel order
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No paper orders.</p>
          )}
        </section>
      )}
      {dashboard && dashboardBottom}
      {account &&
        value &&
        (view === "settings" || (view === "trade" && legacyFixture)) && (
          <section className="platform-product-panel">
            <h3>Paper trading controls</h3>
            {value.emergency_stop && (
              <p role="alert">
                Emergency stop active. Clearing it keeps agents paused.
              </p>
            )}
            <div className="platform-product-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await platform("/paper-account/emergency", "PUT", {
                      enabled: !value.emergency_stop,
                    });
                  })
                }
              >
                {value.emergency_stop
                  ? "Clear paper emergency stop"
                  : "Emergency stop paper trading"}
              </button>
              <button
                disabled={busy}
                onClick={() => setConfirmReset(!confirmReset)}
              >
                Reset virtual funds
              </button>
            </div>
            {confirmReset && (
              <div>
                <p>
                  Reset closes this account epoch and cancels its open orders.
                  Previous fills remain in the order history.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await platform("/paper-account/reset", "POST", {
                        epoch: account.epoch,
                        acknowledge: "RESET_PAPER_ACCOUNT",
                      });
                      setConfirmReset(false);
                    })
                  }
                >
                  Confirm reset
                </button>
              </div>
            )}
          </section>
        )}
    </div>
  );
}
