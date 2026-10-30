import { useId, useState } from "react";
import { ArrowUpRight, Check, Search, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Amount, Dashboard, Page } from "./types";
import { Coin, Modal } from "./ui";

export function WorkspaceHighlights({
  data,
  page,
}: {
  data: Dashboard;
  page: Page;
}) {
  const enabled = data.strategies.filter(
    (strategy) => strategy.config.enabled,
  ).length;
  const assets = new Set(
    data.strategies
      .filter((strategy) => strategy.config.enabled)
      .flatMap((strategy) => strategy.config.assets),
  );
  return (
    <div className="workspace-highlights">
      <div className="coverage-review">
        <div className="coverage-heading">
          <span>Strategy coverage</span>
          <span>
            {enabled} of {data.strategies.length} enabled
          </span>
        </div>
        <div
          className="coverage-track"
          role="meter"
          aria-label="Enabled strategy coverage"
          aria-valuenow={enabled}
          aria-valuemin={0}
          aria-valuemax={data.strategies.length || 1}
        >
          {data.strategies.map((strategy) => (
            <span
              className={strategy.config.enabled ? "enabled" : ""}
              key={strategy.id}
              title={`${strategy.name}: ${strategy.config.enabled ? "enabled" : "disabled"}`}
            />
          ))}
        </div>
        <div className="coverage-foot">
          <span>Rules-based research</span>
          <span>Independent risk checks</span>
        </div>
      </div>
      {page === "strategies" && (
        <div className="discovery-stats">
          {[
            [String(enabled).padStart(2, "0"), "Enabled strategies"],
            [String(assets.size).padStart(2, "0"), "Reference assets"],
            [
              String(data.news.articles.length).padStart(2, "0"),
              "Available stories",
            ],
            [
              String(data.executions.total).padStart(2, "0"),
              "Execution intents",
            ],
          ].map(([value, label]) => (
            <div key={label}>
              <span className="stat-check">
                <Check size={10} />
              </span>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PerformancePreview({
  values,
  label,
}: {
  values: Amount[];
  label: string;
}) {
  const id = useId().replaceAll(":", "");
  const numbers = values.map(Number);
  if (numbers.length < 2 || numbers.some((value) => !Number.isFinite(value)))
    return (
      <div className="preview-unavailable">
        Chart data unavailable. No performance is inferred.
      </div>
    );
  const low = Math.min(...numbers),
    range = Math.max(...numbers) - low || 1;
  const y = (value: number) => 67 - ((value - low) / range) * 53;
  const points = numbers
    .map(
      (value, index) =>
        `${4 + (index * 392) / (numbers.length - 1)},${y(value)}`,
    )
    .join(" ");
  const positive = numbers[numbers.length - 1] >= numbers[0];
  const color = positive ? "var(--positive)" : "var(--negative)";
  return (
    <figure className="performance-preview">
      <svg
        viewBox="0 0 400 84"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`4,84 ${points} 396,84`} fill={`url(#${id})`} />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx="396"
          cy={y(numbers[numbers.length - 1])}
          r="3.5"
          fill={color}
        />
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

export function WorkspaceSearch({
  data,
  pages,
  close,
  navigate,
  setSelected,
}: {
  data: Dashboard | null;
  pages: { id: Page; name: string; icon: LucideIcon }[];
  close: () => void;
  navigate: (page: Page) => void;
  setSelected: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const items = [
    ...pages.map((page) => ({
      id: page.id,
      label: page.name,
      category: "Workspace",
      icon: <page.icon size={18} />,
      action: () => navigate(page.id),
    })),
    ...(data?.markets ?? []).map((market) => ({
      id: market.asset.asset_id,
      label: `${market.asset.name} · ${market.asset.symbol}`,
      category: "Market",
      icon: <Coin symbol={market.asset.symbol} />,
      action: () => {
        setSelected(market.asset.symbol);
        navigate("markets");
      },
    })),
    ...(data?.strategies ?? []).map((strategy) => ({
      id: strategy.id,
      label: strategy.name,
      category: "Strategy",
      icon: <SlidersHorizontal size={18} />,
      action: () => navigate("strategies"),
    })),
  ]
    .filter((item) =>
      `${item.label} ${item.category}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
    )
    .slice(0, 12);
  const choose = (action: () => void) => {
    action();
    close();
  };
  return (
    <Modal title="Search workspace" close={close}>
      <form
        className="workspace-search-input"
        onSubmit={(event) => {
          event.preventDefault();
          if (items[0]) choose(items[0].action);
        }}
      >
        <Search size={19} />
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search pages, markets and strategies"
          placeholder="Search pages, markets, strategies…"
        />
      </form>
      <div className="workspace-search-results">
        {items.length ? (
          items.map((item) => (
            <button key={item.id} onClick={() => choose(item.action)}>
              <span className="search-result-icon">{item.icon}</span>
              <span>
                {item.label}
                <small>{item.category}</small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))
        ) : (
          <p className="note">
            No matches. Try an asset symbol or a workspace name.
          </p>
        )}
      </div>
      <p className="search-hint">
        Enter opens the first result. Escape closes search.
      </p>
    </Modal>
  );
}
