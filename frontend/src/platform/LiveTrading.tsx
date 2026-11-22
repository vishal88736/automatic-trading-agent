import { useEffect, useState, type FormEvent } from "react";
import {
  CircleCheck,
  ExternalLink,
  KeyRound,
  Link2,
  Lock,
  OctagonX,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Coin, money, number, timestamp } from "../ui";
import { platform } from "./client";
import { marketAssets, type MarketAsset } from "./market-assets";
import { useMarkets } from "./useMarkets";
import { WalletView } from "./WalletView";

type Environment = "testnet" | "live";
type Exchange = "binance" | "bybit" | "okx";
export const exchangeNames: Record<Exchange, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
};
export interface Connection {
  id: string;
  exchange: Exchange;
  environment: Environment;
  label: string;
  key_hint: string;
  permissions: {
    can_trade?: boolean;
    withdrawals?: boolean | string;
    ip_restricted?: boolean | null;
  };
  max_order_usdt: string;
  status: "ACTIVE" | "PAUSED";
  verified_at: string;
}
interface Account {
  balances: {
    asset: string;
    free: string;
    locked: string;
    total: string;
    price: string | null;
    value: string | null;
  }[];
  total_value: string;
  complete: boolean;
}
export interface LiveOrder {
  id: string;
  asset: MarketAsset;
  side: "BUY" | "SELL";
  quote_amount: string | null;
  quantity?: string | null;
  agent_id?: string | null;
  status: string;
  executed_qty: string | null;
  quote_filled: string | null;
  average_price: string | null;
  error: string | null;
  created_at: string;
}

type Guide = { title: string; steps: string[]; link: string };
const guides: Record<Exchange, Record<Environment, Guide>> = {
  binance: {
    testnet: {
      title: "Get a free Binance Spot Testnet key",
      link: "https://testnet.binance.vision/",
      steps: [
        "Open testnet.binance.vision and log in with GitHub.",
        "Click Generate HMAC_SHA256 Key and give it a name.",
        "Copy the API key and secret key into this form.",
        "The testnet account comes funded with test BTC, ETH, USDT and more.",
      ],
    },
    live: {
      title: "Create a trade-only Binance API key",
      link: "https://www.binance.com/en/my/settings/api-management",
      steps: [
        "On Binance, open Account → API Management → Create API (system generated).",
        "Turn ON Enable Spot & Margin Trading.",
        "Keep Enable Withdrawals OFF. Krono rejects keys that can withdraw.",
        "Restrict access to trusted IPs and add this server's IP address.",
      ],
    },
  },
  bybit: {
    testnet: {
      title: "Get a free Bybit Testnet key",
      link: "https://testnet.bybit.com/app/user/api-management",
      steps: [
        "Sign up at testnet.bybit.com (separate from a real Bybit account).",
        "Request test coins from the testnet Assets page.",
        "Create a system-generated API key: Read-Write, Spot → Trade.",
        "Copy the API key and secret into this form.",
      ],
    },
    live: {
      title: "Create a trade-only Bybit API key",
      link: "https://www.bybit.com/app/user/api-management",
      steps: [
        "On Bybit, open API → Create New Key → System-generated.",
        "Choose Read-Write and tick Spot → Trade only.",
        "Leave Wallet → Withdraw unticked. Krono rejects keys that can withdraw.",
        "Bind the key to this server's IP address.",
      ],
    },
  },
  okx: {
    testnet: {
      title: "Get a free OKX demo trading key",
      link: "https://www.okx.com/account/my-api",
      steps: [
        "On OKX, switch to Demo trading (Trade → Demo trading).",
        "Open Personal center → Demo trading API → Create V5 API key.",
        "Give it Trade permission and set a passphrase.",
        "Paste the API key, secret and passphrase here.",
      ],
    },
    live: {
      title: "Create a trade-only OKX API key",
      link: "https://www.okx.com/account/my-api",
      steps: [
        "On OKX, open Profile → API → Create V5 API key.",
        "Grant Read and Trade permissions only, never Withdraw.",
        "Set a passphrase and bind the key to this server's IP address.",
        "Paste the API key, secret and passphrase here.",
      ],
    },
  },
};

function LinkExchange({ onLinked }: { onLinked: (c: Connection) => void }) {
  const [exchange, setExchange] = useState<Exchange>("binance");
  const [environment, setEnvironment] = useState<Environment>("testnet");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const guide = guides[exchange][environment];
  const name = exchangeNames[exchange];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true);
    setError("");
    try {
      const connection = await platform<Connection>(
        "/live/connections",
        "POST",
        {
          exchange,
          environment,
          label: form.get("label"),
          api_key: String(form.get("api_key")).trim(),
          api_secret: String(form.get("api_secret")).trim(),
          api_passphrase: String(form.get("api_passphrase") ?? ""),
          max_order_usdt: form.get("max_order_usdt"),
        },
      );
      element.reset();
      onLinked(connection);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="kx-card kx-link-card">
      <div className="kx-link-form">
        <h2 className="kx-card-title">
          <Link2 size={17} aria-hidden /> Link an exchange account
        </h2>
        <div className="kx-exchange-picker" role="group" aria-label="Exchange">
          {(Object.keys(exchangeNames) as Exchange[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={exchange === value}
              onClick={() => setExchange(value)}
            >
              <span className="kx-exchange-logo" aria-hidden>
                {exchangeNames[value][0]}
              </span>
              {exchangeNames[value]}
            </button>
          ))}
        </div>
        <div className="kx-segmented" role="group" aria-label="Environment">
          {(["testnet", "live"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={environment === value}
              onClick={() => setEnvironment(value)}
            >
              {value === "live"
                ? "Live (real funds)"
                : exchange === "okx"
                  ? "Demo (free test funds)"
                  : "Testnet (free test funds)"}
            </button>
          ))}
        </div>
        {error && (
          <p className="platform-error" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={submit} autoComplete="off">
          <label>
            Name
            <input
              name="label"
              required
              maxLength={60}
              defaultValue={
                environment === "testnet" ? `${name} Testnet` : name
              }
              key={exchange + environment}
            />
          </label>
          <label>
            API key
            <input
              name="api_key"
              required
              minLength={16}
              maxLength={128}
              spellCheck={false}
            />
          </label>
          <label>
            Secret key
            <input
              name="api_secret"
              type="password"
              required
              minLength={16}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          {exchange === "okx" && (
            <label>
              Passphrase
              <input
                name="api_passphrase"
                type="password"
                required
                maxLength={64}
                autoComplete="new-password"
              />
            </label>
          )}
          <label>
            Max order size (USDT)
            <input
              name="max_order_usdt"
              type="number"
              min="1"
              max="100000"
              step="0.01"
              defaultValue={environment === "testnet" ? "1000" : "100"}
              key={environment + "-max"}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? (
              <RefreshCw size={15} className="spin" />
            ) : (
              <KeyRound size={15} />
            )}
            {busy ? `Verifying key with ${name}…` : "Verify and link"}
          </button>
          <p className="kx-footnote">
            <Lock size={13} aria-hidden /> Krono checks the key's permissions,
            then stores it encrypted (AES-256-GCM). The secret is never shown
            again and never reaches your browser.
          </p>
        </form>
      </div>
      <aside className="kx-link-guide">
        <h3>{guide.title}</h3>
        <ol>
          {guide.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <a
          className="kx-link"
          href={guide.link}
          target="_blank"
          rel="noreferrer"
        >
          Open {name} <ExternalLink size={13} />
        </a>
      </aside>
    </section>
  );
}

function OrderTicket({
  connection,
  onPlaced,
}: {
  connection: Connection;
  onPlaced: () => void;
}) {
  const markets = useMarkets();
  const [asset, setAsset] = useState<MarketAsset>("BTC");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [amount, setAmount] = useState("20");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: string; text: string }>();
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const price = markets?.find((m) => m.asset === asset)?.price ?? null;
  const live = connection.environment === "live";
  const limit = Number(connection.max_order_usdt);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult(undefined);
    try {
      const order = await platform<LiveOrder>(
        `/live/connections/${connection.id}/orders`,
        "POST",
        {
          request_key: requestKey,
          asset,
          side,
          quote_amount: Number(amount).toFixed(2),
          acknowledge_live: live && confirm,
        },
      );
      setResult(
        order.status === "FILLED"
          ? {
              tone: "positive",
              text: `${side === "BUY" ? "Bought" : "Sold"} ${number(order.executed_qty, 8)} ${asset} at ${money(order.average_price)}`,
            }
          : {
              tone: "negative",
              text: `${order.status}${order.error ? ` · ${order.error}` : ""}`,
            },
      );
      setRequestKey(crypto.randomUUID());
      setConfirm(false);
      onPlaced();
    } catch (err) {
      // Keep the same request key: a retry can never place the order twice.
      setResult({ tone: "negative", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="kx-card kx-ticket" aria-label="Order ticket">
      <h2 className="kx-card-title">Market order</h2>
      <div className="kx-asset-picker">
        {marketAssets.map((symbol) => {
          const quote = markets?.find((m) => m.asset === symbol);
          return (
            <button
              key={symbol}
              type="button"
              aria-pressed={asset === symbol}
              onClick={() => setAsset(symbol)}
            >
              <Coin symbol={symbol} />
              <span>
                <strong>{symbol}</strong>
                <small className="kx-num">{money(quote?.price)}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="kx-side-toggle" role="group" aria-label="Order side">
        {(["BUY", "SELL"] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-side={value.toLowerCase()}
            aria-pressed={side === value}
            onClick={() => setSide(value)}
          >
            {value === "BUY" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <form onSubmit={submit}>
        <label>
          Amount (USDT)
          <input
            type="number"
            min="1"
            max={limit}
            step="0.01"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <div className="kx-chips-inline">
          {[10, 25, 50, 100]
            .filter((value) => value <= limit)
            .map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setAmount(String(value))}
              >
                {value}
              </button>
            ))}
          <button type="button" onClick={() => setAmount(String(limit))}>
            Max {limit}
          </button>
        </div>
        <p className="kx-estimate">
          ≈ {price ? number(Number(amount) / price, 6) : "—"} {asset}
          <small> at {money(price)} (live price)</small>
        </p>
        {live && (
          <label className="kx-check">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(event) => setConfirm(event.target.checked)}
            />
            I understand this order uses real funds on my{" "}
            {exchangeNames[connection.exchange]} account.
          </label>
        )}
        <button
          className={side === "BUY" ? "primary kx-block" : "danger kx-block"}
          disabled={
            busy || connection.status !== "ACTIVE" || (live && !confirm)
          }
        >
          {busy
            ? `Sending to ${exchangeNames[connection.exchange]}…`
            : `${side === "BUY" ? "Buy" : "Sell"} ${asset}`}
        </button>
        {connection.status !== "ACTIVE" && (
          <p className="kx-callout" data-tone="warning">
            Trading is paused for this connection.
          </p>
        )}
        {result && (
          <p
            className={
              result.tone === "positive" ? "kx-notice" : "platform-error"
            }
            role="status"
          >
            {result.text}
          </p>
        )}
      </form>
    </section>
  );
}

function ConnectionView({
  connection,
  onChanged,
  onRemoved,
}: {
  connection: Connection;
  onChanged: (c: Connection) => void;
  onRemoved: () => void;
}) {
  const [account, setAccount] = useState<Account>();
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const path = `/live/connections/${connection.id}`;

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [nextAccount, nextOrders] = await Promise.all([
          platform<Account>(`${path}/account`),
          platform<{ items: LiveOrder[] }>(`${path}/orders`),
        ]);
        if (!active) return;
        setAccount(nextAccount);
        setOrders(nextOrders.items);
        setError("");
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 20000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, refresh]);

  async function control(action: "pause" | "resume") {
    setBusy(true);
    try {
      const result = await platform<{
        status: Connection["status"];
        cancelled_orders: number;
      }>(`${path}/control`, "POST", { action });
      onChanged({ ...connection, status: result.status });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !confirm(
        `Disconnect "${connection.label}"? Krono deletes the stored key.`,
      )
    )
      return;
    setBusy(true);
    try {
      await platform(path, "DELETE");
      onRemoved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const withdrawals = connection.permissions.withdrawals;
  return (
    <div className="kx-stack">
      <section className="kx-card kx-connection-head">
        <div>
          <h2>
            {connection.label}{" "}
            <span
              className="kx-badge"
              data-tone={
                connection.environment === "live" ? "warning" : "accent"
              }
            >
              {connection.environment === "live"
                ? "Live · real funds"
                : "Testnet"}
            </span>
          </h2>
          <p className="muted">
            {exchangeNames[connection.exchange]} Spot · key{" "}
            {connection.key_hint} · verified {timestamp(connection.verified_at)}
          </p>
          <ul className="kx-permissions">
            <li data-ok>
              <CircleCheck size={14} aria-hidden /> Trading enabled
            </li>
            <li data-ok>
              <ShieldCheck size={14} aria-hidden />
              {withdrawals === false
                ? "Withdrawals disabled"
                : "Test funds only"}
            </li>
            {connection.permissions.ip_restricted === false && (
              <li>
                <Lock size={14} aria-hidden /> No IP restriction. Add one on{" "}
                {exchangeNames[connection.exchange]}.
              </li>
            )}
            <li>Max order {money(connection.max_order_usdt, 0)}</li>
          </ul>
        </div>
        <div className="kx-actions">
          <span
            className="kx-status kx-status-lg"
            data-status={connection.status === "ACTIVE" ? "RUNNING" : "PAUSED"}
          >
            {connection.status === "ACTIVE" ? "Trading on" : "Paused"}
          </span>
          {connection.status === "ACTIVE" ? (
            <button
              className="danger"
              disabled={busy}
              onClick={() => void control("pause")}
            >
              <OctagonX size={15} /> Kill switch
            </button>
          ) : (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void control("resume")}
            >
              <Play size={15} /> Resume trading
            </button>
          )}
          <button
            className="kx-icon-button"
            aria-label="Disconnect exchange"
            title="Disconnect"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </section>

      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}

      <div className="kx-live-grid">
        <section className="kx-card">
          <div className="kx-toolbar">
            <div>
              <span className="muted">Account value</span>
              <p className="kx-big kx-num">
                {account ? money(account.total_value) : "—"}
              </p>
              {account && !account.complete && (
                <small>Assets without a USDT price are not included.</small>
              )}
            </div>
            <button
              className="kx-icon-button"
              aria-label="Refresh account"
              onClick={() => setRefresh((n) => n + 1)}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {!account && !error && (
            <p className="kx-loading">
              Loading balances from {exchangeNames[connection.exchange]}…
            </p>
          )}
          {account && (
            <div className="kx-table-scroll">
              <table className="kx-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th className="num">Available</th>
                    <th className="num">In orders</th>
                    <th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {account.balances.slice(0, 12).map((balance) => (
                    <tr key={balance.asset}>
                      <td>
                        <span className="kx-asset">
                          {["BTC", "ETH", "SOL"].includes(balance.asset) && (
                            <Coin symbol={balance.asset} />
                          )}
                          {balance.asset}
                        </span>
                      </td>
                      <td className="num kx-num">{number(balance.free, 6)}</td>
                      <td className="num kx-num">
                        {number(balance.locked, 6)}
                      </td>
                      <td className="num kx-num">{money(balance.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <OrderTicket
          connection={connection}
          onPlaced={() => setRefresh((n) => n + 1)}
        />
      </div>

      <section className="kx-card kx-table-card">
        <h2 className="kx-card-title kx-pad">Order history</h2>
        {orders.length === 0 ? (
          <p className="muted kx-pad">No live orders yet.</p>
        ) : (
          <div className="kx-table-scroll">
            <table className="kx-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th>Asset</th>
                  <th className="num">Amount</th>
                  <th className="num">Filled</th>
                  <th className="num">Avg price</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>{timestamp(order.created_at)}</td>
                    <td>
                      <span
                        className="kx-side"
                        data-side={order.side.toLowerCase()}
                      >
                        {order.side}
                      </span>
                    </td>
                    <td>
                      {order.asset}
                      {order.agent_id && <span className="kx-pill">Agent</span>}
                    </td>
                    <td className="num kx-num">
                      {order.quote_amount
                        ? money(order.quote_amount)
                        : `${number(order.quantity, 8)} ${order.asset}`}
                    </td>
                    <td className="num kx-num">
                      {order.executed_qty ? number(order.executed_qty, 8) : "—"}
                    </td>
                    <td className="num kx-num">{money(order.average_price)}</td>
                    <td>
                      <span
                        className="kx-status"
                        data-status={
                          order.status === "FILLED"
                            ? "RUNNING"
                            : order.status === "REJECTED"
                              ? "FAILED"
                              : "PAUSED"
                        }
                        title={order.error ?? undefined}
                      >
                        {order.status.toLowerCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function LiveTrading() {
  const [data, setData] = useState<{
    items: Connection[];
    configured: boolean;
  }>();
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  async function load(select?: string) {
    try {
      const next = await platform<{ items: Connection[]; configured: boolean }>(
        "/live/connections",
      );
      setData(next);
      setSelected(
        (current) =>
          select ??
          (next.items.some((c) => c.id === current)
            ? current
            : (next.items[0]?.id ?? "")),
      );
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const connection = data?.items.find((item) => item.id === selected);
  return (
    <div className="kx-stack">
      {error && (
        <p className="platform-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="kx-loading">Loading connections…</p>}
      {data && !data.configured && (
        <p className="kx-callout" data-tone="warning">
          Live trading is not configured on this server. Set
          KRONO_CREDENTIAL_KEY for the product API (make dev does this
          automatically).
        </p>
      )}
      {data && data.items.length > 0 && (
        <div className="kx-toolbar">
          <div
            className="kx-segmented"
            role="group"
            aria-label="Exchange connections"
          >
            {data.items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === selected && !adding}
                onClick={() => {
                  setSelected(item.id);
                  setAdding(false);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="secondary" onClick={() => setAdding(!adding)}>
            <Plus size={15} /> Link another account
          </button>
        </div>
      )}
      {data?.configured && (data.items.length === 0 || adding) && (
        <LinkExchange
          onLinked={(item) => {
            setAdding(false);
            void load(item.id);
          }}
        />
      )}
      {connection && !adding && (
        <ConnectionView
          key={connection.id}
          connection={connection}
          onChanged={(next) =>
            setData(
              (current) =>
                current && {
                  ...current,
                  items: current.items.map((item) =>
                    item.id === next.id ? next : item,
                  ),
                },
            )
          }
          onRemoved={() => void load("")}
        />
      )}
      <WalletView />
      <p className="kx-footnote">
        Funds always stay on your exchange account: Krono can place and cancel
        orders but can never withdraw. Binance, Bybit and OKX are supported,
        each with a free test environment.
      </p>
    </div>
  );
}
