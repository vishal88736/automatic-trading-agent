import { useEffect, useState } from "react";
import { platform } from "./client";
import { timestamp } from "../ui";

interface Document {
  name: string;
  description?: string;
  definition: {
    asset: string;
    timeframe?: string;
  };
}

interface Revision {
  id: string;
  version: number;
  document: Document;
  created_at: string;
}

const example = JSON.stringify(
  {
    name: "BTC RSI rules",
    description: "",
    definition: {
      schema_version: 1,
      asset: "BTC",
      timeframe: "1h",
      entry: {
        conditions: [{ indicator: "rsi", operator: "lt", threshold: "30" }],
      },
      exit: {
        conditions: [
          { indicator: "rsi", operator: "crosses_above", threshold: "65" },
        ],
      },
      cash_fraction: "0.02",
      stop_loss: "0.04",
    },
  },
  null,
  2,
);

export function Strategies() {
  const [records, setRecords] = useState<Revision[]>([]);
  const [active, setActive] = useState<Revision | null>(null);
  const [history, setHistory] = useState<Revision[]>([]);
  const [historical, setHistorical] = useState<Revision | null>(null);
  const [draft, setDraft] = useState(example);
  const [nextCursor, setNextCursor] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const path = "/custom-strategies";
  const pageSize = 50;

  useEffect(() => {
    let mounted = true;
    platform<{ items: Revision[] }>(path)
      .then(({ items }) => {
        if (mounted) {
          setRecords(items);
          setNextCursor(
            items.length === pageSize ? items.at(-1)?.id : undefined,
          );
        }
      })
      .catch((err: Error) => mounted && setError(err.message))
      .finally(() => mounted && setBusy(false));
    return () => {
      mounted = false;
    };
  }, []);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function select(record: Revision | null) {
    setActive(record);
    setDraft(record ? JSON.stringify(record.document, null, 2) : example);
    setHistory([]);
    setHistorical(null);
    setError("");
    setStatus("");
  }

  function save(duplicate = false) {
    void act(async () => {
      const document = JSON.parse(draft);
      const editing = active && !duplicate;
      const saved = editing
        ? await platform<Revision>(`${path}/${active.id}`, "PUT", {
            document,
            expected_version: active.version,
          })
        : await platform<Revision>(path, "POST", document);
      setRecords((items) =>
        editing
          ? items.map((item) => (item.id === saved.id ? saved : item))
          : [...items, saved],
      );
      select(saved);
      setStatus(`Saved version ${saved.version}.`);
    });
  }

  return (
    <div className="platform-product-editor">
      <section
        className="platform-product-panel"
        aria-labelledby="saved-strategies"
      >
        <h3 id="saved-strategies">Saved strategies</h3>
        <button type="button" onClick={() => select(null)} disabled={busy}>
          New strategy
        </button>
        <ul className="platform-strategy-list">
          {records.map((record) => (
            <li key={record.id}>
              <button
                type="button"
                aria-pressed={active?.id === record.id}
                disabled={busy}
                onClick={() => select(record)}
              >
                {record.document.name} · {record.document.definition.asset} · v
                {record.version}
              </button>
            </li>
          ))}
        </ul>
        {records.length === 0 && !busy && !error && <p>No saved strategies.</p>}
        {nextCursor && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const { items } = await platform<{ items: Revision[] }>(
                  `${path}?after=${nextCursor}`,
                );
                setRecords((current) => [
                  ...current.filter(
                    (item) => !items.some((next) => next.id === item.id),
                  ),
                  ...items,
                ]);
                setNextCursor(
                  items.length === pageSize ? items.at(-1)?.id : undefined,
                );
              })
            }
          >
            More strategies
          </button>
        )}
      </section>
      <section
        className="platform-product-panel"
        aria-labelledby="structured-heading"
      >
        <h3 id="structured-heading">Structured editor</h3>
        <label htmlFor="strategy-document">Strategy JSON</label>
        <textarea
          id="strategy-document"
          spellCheck={false}
          value={draft}
          disabled={busy}
          rows={18}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="platform-product-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => save()}
          >
            Save strategy
          </button>
          {active && (
            <>
              <button type="button" disabled={busy} onClick={() => save(true)}>
                Save as copy
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await platform<{ items: Revision[] }>(
                      `${path}/${active.id}/versions`,
                    );
                    setHistory(result.items);
                    setHistorical(null);
                  })
                }
              >
                Version history
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await platform<void>(
                      `${path}/${active.id}/archive`,
                      "POST",
                      { expected_version: active.version },
                    );
                    setRecords((items) =>
                      items.filter((item) => item.id !== active.id),
                    );
                    select(null);
                    setStatus("Strategy archived.");
                  })
                }
              >
                Archive strategy
              </button>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="platform-error">
            {error}
          </p>
        )}
        <p role="status">{busy ? "Working…" : status}</p>
        {history.length > 0 && (
          <div>
            <label htmlFor="strategy-version">Compare saved version</label>
            <select
              id="strategy-version"
              value={historical?.version ?? ""}
              onChange={(event) =>
                setHistorical(
                  history.find(
                    (item) => item.version === Number(event.target.value),
                  ) ?? null,
                )
              }
            >
              <option value="">Select a version</option>
              {history.map((item) => (
                <option key={item.version} value={item.version}>
                  Version {item.version} · {timestamp(item.created_at)}
                </option>
              ))}
            </select>
            {historical && (
              <pre aria-label="Selected strategy version">
                {JSON.stringify(historical.document, null, 2)}
              </pre>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
