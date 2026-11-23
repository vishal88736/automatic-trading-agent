import { useEffect, useState } from "react";
import { ArrowUpRight, RefreshCw, Wallet } from "lucide-react";
import { money, number } from "../ui";
import { platform } from "./client";
import {
  exchangeNames,
  type Connection,
  type LiveAccount,
} from "./LiveTrading";
import { workspaceHref } from "./navigation";

function LinkedAccount({ connection }: { connection: Connection }) {
  const [account, setAccount] = useState<LiveAccount>();
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setUpdating(true);
      try {
        const next = await platform<LiveAccount>(
          `/live/connections/${connection.id}/account`,
        );
        if (active) {
          setAccount(next);
          setError("");
        }
      } catch (err) {
        if (active) setError((err as Error).message);
      } finally {
        if (active) {
          setUpdating(false);
          timer = setTimeout(() => void load(), 30000);
        }
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [connection.id, revision]);

  return (
    <div className="live-overview-grid">
      <div className="platform-product-panel live-overview-summary">
        <div className="dashboard-panel-heading">
          <h3>
            <Wallet size={17} aria-hidden /> Account value
          </h3>
          <button
            type="button"
            className="kx-icon-button"
            aria-label="Refresh live balances"
            disabled={updating}
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw size={15} aria-hidden />
          </button>
        </div>
        <strong className="live-overview-value kx-num">
          {money(account?.total_value)}
        </strong>
        <p className="muted">
          {exchangeNames[connection.exchange]} ·{" "}
          {connection.environment === "live" ? "Live funds" : "Testnet funds"}
          {connection.status === "PAUSED" && " · Trading paused"}
        </p>
        {account && !account.complete && (
          <p className="muted">Total includes balances with a USDT price.</p>
        )}
        {!account && !error && <p role="status">Loading exchange balances…</p>}
        {error && (
          <p role="alert" className="platform-error">
            {account ? "Showing the last available balances. " : ""}
            {error}
          </p>
        )}
      </div>
      <div className="platform-product-panel live-overview-holdings">
        <div className="dashboard-panel-heading">
          <h3>Exchange balances</h3>
        </div>
        {account?.balances.length ? (
          <div
            className="kx-table-scroll"
            role="region"
            aria-label="Exchange balances table"
            tabIndex={0}
          >
            <table className="kx-table">
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col" className="num">
                    Available
                  </th>
                  <th scope="col" className="num">
                    In orders
                  </th>
                  <th scope="col" className="num">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {account.balances.map((balance) => (
                  <tr key={balance.asset}>
                    <th scope="row">{balance.asset}</th>
                    <td className="num kx-num">{number(balance.free, 8)}</td>
                    <td className="num kx-num">{number(balance.locked, 8)}</td>
                    <td className="num kx-num">{money(balance.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            {account
              ? "This exchange account has no spot balances."
              : "Waiting for exchange data."}
          </p>
        )}
      </div>
    </div>
  );
}

export default function LiveOverview() {
  const [data, setData] = useState<{
    items: Connection[];
    configured: boolean;
  }>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    platform<{ items: Connection[]; configured: boolean }>("/live/connections")
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  const connection =
    data?.items.find((item) => item.id === selected) ?? data?.items[0];
  return (
    <section className="overview-section" aria-labelledby="overview-live">
      <div className="overview-section-header">
        <h2 id="overview-live">Live trading dashboard</h2>
        <a
          className="kx-link"
          href={workspaceHref(
            "live",
            connection
              ? `?connection=${encodeURIComponent(connection.id)}`
              : "",
          )}
        >
          {connection ? "Manage exchange" : "Live trading"}{" "}
          <ArrowUpRight size={15} aria-hidden />
        </a>
      </div>
      {connection ? (
        <>
          <label className="live-overview-account">
            Exchange account
            <select
              value={connection.id}
              onChange={(event) => setSelected(event.target.value)}
            >
              {data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {exchangeNames[item.exchange]} ·{" "}
                  {item.environment === "live" ? "Live" : "Testnet"}
                </option>
              ))}
            </select>
          </label>
          <LinkedAccount connection={connection} key={connection.id} />
        </>
      ) : (
        <div className="platform-product-panel">
          {error ? (
            <>
              <p role="alert" className="platform-error">
                {error}
              </p>
              <button type="button" onClick={() => setRevision((n) => n + 1)}>
                Retry live connection
              </button>
            </>
          ) : !data ? (
            <p role="status">Loading exchange connections…</p>
          ) : data.configured ? (
            <>
              <p className="muted">
                Link an exchange to see its spot balances and account value.
              </p>
              <a className="button secondary" href={workspaceHref("live")}>
                Link an exchange account
              </a>
            </>
          ) : (
            <p className="muted">Live trading is disabled on this server.</p>
          )}
        </div>
      )}
    </section>
  );
}
