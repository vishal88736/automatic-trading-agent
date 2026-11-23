import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Coin, percent } from "../ui";
import { platform } from "./client";
import { workspaceHref } from "./navigation";

interface RankedStrategy {
  rank: number;
  share_id: string;
  owner: string;
  strategy: string;
  asset: string;
  return_pct: string;
  max_drawdown: string;
  fills: number;
}

interface RankingsPage {
  items: RankedStrategy[];
  next_offset: number | null;
}

export default function StrategyRankings() {
  const [data, setData] = useState<RankingsPage>();
  const [error, setError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [retry, setRetry] = useState(0);
  const [offset, setOffset] = useState(0);
  const [copying, setCopying] = useState<string>();
  const [copied, setCopied] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    setData(undefined);
    setError("");
    platform<RankingsPage>(`/ranked-strategies?offset=${offset}`)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [offset, retry]);

  async function copy(entry: RankedStrategy) {
    setCopying(entry.share_id);
    setCopyError("");
    try {
      const result = await platform<{ id: string }>(
        `/ranked-strategies/${entry.share_id}/copy`,
        "POST",
      );
      setCopied((previous) => ({ ...previous, [entry.share_id]: result.id }));
    } catch (err) {
      setCopyError((err as Error).message);
    } finally {
      setCopying(undefined);
    }
  }

  return (
    <section className="kx-card kx-table-card">
      {error && (
        <div className="strategy-rankings-message">
          <p className="platform-error" role="alert">
            {error}
          </p>
          <button type="button" onClick={() => setRetry(retry + 1)}>
            Retry
          </button>
        </div>
      )}
      {copyError && (
        <p className="strategy-rankings-message platform-error" role="alert">
          {copyError}
        </p>
      )}
      {!error && !data && (
        <p className="strategy-rankings-message" role="status">
          Loading ranked strategies…
        </p>
      )}
      {data?.items.length === 0 && (
        <p className="strategy-rankings-message muted">
          No strategies with filled trades and positive recorded paper returns
          yet.
        </p>
      )}
      {!!data?.items.length && (
        <div
          className="kx-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Ranked strategies"
        >
          <table className="kx-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Strategy</th>
                <th scope="col">Market</th>
                <th scope="col" className="num">
                  Paper return
                </th>
                <th scope="col" className="num">
                  Max drawdown
                </th>
                <th scope="col" className="num">
                  Fills
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <tr key={entry.share_id}>
                  <td className="kx-rank">{entry.rank}</td>
                  <td>
                    <strong>{entry.strategy}</strong>
                    <small>{entry.owner}</small>
                  </td>
                  <td>
                    <span className="kx-asset">
                      <Coin symbol={entry.asset} /> {entry.asset}
                    </span>
                  </td>
                  <td className="num">
                    <span className="kx-num kx-change" data-direction="up">
                      +{percent(entry.return_pct)}
                    </span>
                  </td>
                  <td className="num kx-num">{percent(entry.max_drawdown)}</td>
                  <td className="num kx-num">{entry.fills}</td>
                  <td>
                    {copied[entry.share_id] ? (
                      <a
                        className="kx-link"
                        href={workspaceHref(
                          "saved-strategies",
                          `?strategy=${copied[entry.share_id]}`,
                        )}
                      >
                        Open copy
                      </a>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Copy ${entry.strategy}`}
                        disabled={!!copying}
                        onClick={() => void copy(entry)}
                      >
                        <Copy size={14} aria-hidden />{" "}
                        {copying === entry.share_id ? "Copying…" : "Copy"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(offset > 0 || data?.next_offset != null) && (
        <nav
          className="kx-toolbar strategy-rankings-message"
          aria-label="Strategy ranking pages"
        >
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={data?.next_offset == null}
            onClick={() => setOffset(data?.next_offset ?? offset)}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
