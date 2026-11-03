import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CirclePlay,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  Settings2,
  ShieldAlert,
} from "lucide-react";
import { api } from "./api";
import { Badge, Empty, Panel } from "./ui";

/* Trading sessions: one start → stop run of the AEGIS agent, rebuilt from the durable ledger. */

type Summary = {
  id: string;
  number: number;
  status: "running" | "ended";
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  end_label: string;
  duration_seconds: number;
  start_nav_usdt: string | null;
  end_nav_usdt: string | null;
  net_pnl_usdt: string | null;
  net_pnl_pct: string | null;
  realized_pnl_usdt: string;
  trades: number;
  entries: number;
  exits: number;
  wins: number;
  losses: number;
  assets: string[];
  strategies: string[];
};
type TimelineItem = {
  id: string;
  at: number;
  kind: "start" | "stop" | "buy" | "sell" | "risk" | "settings";
  title: string;
  detail?: string | null;
  asset?: string;
  quantity?: string;
  notional_usdt?: string;
  price_usdt?: string | null;
  market_price_usdt?: string | null;
  confidence?: string | null;
  realized_pnl_usdt?: string | null;
  strategy_id?: string | null;
  strategy_name?: string | null;
  nav_usdt?: string | null;
  receipt?: string | null;
};
type Position = {
  asset: string;
  strategy_id: string | null;
  entry_at: number;
  entry_price_usdt: string | null;
  cost_usdt: string;
  exit_at: number | null;
  exit_price_usdt: string | null;
  exit_reason: string | null;
  status: "closed" | "open" | "partial";
  realized_pnl_usdt: string | null;
  return_pct: string | null;
  holding_seconds: number | null;
};
type Detail = Summary & {
  settings: Record<string, unknown>;
  settings_source: string;
  positions: Position[];
  strategy_breakdown: {
    strategy_id: string;
    positions: number;
    realized_pnl_usdt: string;
  }[];
  activity: Record<string, number>;
  timeline: TimelineItem[];
  series: { at: number; nav_usdt: string }[];
};

const STRATEGY_NAMES: Record<string, string> = {
  mean_reversion: "Pool mean reversion",
  arbitrage: "V3 arbitrage",
  momentum_v1: "Momentum",
  mean_reversion_v1: "Mean reversion",
  trend_following_v1: "Trend following",
  breakout_v1: "Breakout",
  spread_research_v1: "Spread research",
};
const strategyName = (id?: string | null, name?: string | null) =>
  name || (id ? (STRATEGY_NAMES[id] ?? id.replaceAll("_", " ")) : "—");

function usdt(value: string | null | undefined, signed = false) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  const digits = Math.abs(n) >= 100 ? 2 : 4;
  const text = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
  return `${signed ? (n > 0 ? "+" : n < 0 ? "−" : "") : n < 0 ? "−" : ""}${text} USDT`;
}
function price(value: string | null | undefined) {
  if (!value) return "—";
  const n = Number(value);
  return n.toLocaleString("en-US", {
    maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 6,
    minimumFractionDigits: n >= 1000 ? 2 : 0,
  });
}
function pct(value: string | null | undefined) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
}
function quantity(value: string | null | undefined) {
  if (!value) return "—";
  return Number(value).toLocaleString("en-US", { maximumSignificantDigits: 6 });
}
const tone = (value: string | null | undefined) =>
  value === null || value === undefined || Number(value) === 0
    ? "neutral"
    : Number(value) > 0
      ? "positive"
      : "negative";
function duration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "—";
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    s = seconds % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
const dateTime = (at: number) =>
  new Date(at * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
const clock = (at: number) =>
  new Date(at * 1000).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  });
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Sessions could not be loaded";

export function SessionsWorkspace() {
  const [items, setItems] = useState<Summary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    api<{ items: Summary[] }>("/aegis/sessions")
      .then((value) => {
        if (!active) return;
        setItems(value.items);
        setError("");
        setSelected((current) =>
          current && value.items.some((s) => s.id === current)
            ? current
            : (value.items[0]?.id ?? null),
        );
      })
      .catch((e) => active && setError(message(e)));
    return () => {
      active = false;
    };
  }, [reload]);
  const running = items?.some((s) => s.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setReload((v) => v + 1), 15000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (!selected) return setDetail(null);
    let active = true;
    setLoading(true);
    api<Detail>(`/aegis/sessions/${selected}`)
      .then((value) => active && setDetail(value))
      .catch((e) => active && setError(message(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [selected, reload]);
  if (error && !items)
    return (
      <div role="alert" className="aegis-error">
        {error}
        <button
          className="button secondary"
          onClick={() => setReload((v) => v + 1)}
        >
          Retry
        </button>
      </div>
    );
  if (!items)
    return (
      <p className="muted sessions-loading">
        <LoaderCircle size={14} className="spin" /> Loading sessions…
      </p>
    );
  if (!items.length)
    return (
      <Panel title="Trading sessions">
        <Empty
          title="No sessions yet"
          description="A session begins when you start the AEGIS agent and ends when you pause it, press PANIC or restart. Start the agent from AEGIS · HSKSwap to record your first one."
        />
      </Panel>
    );
  return (
    <div className="sessions-layout">
      <aside className="sessions-list" aria-label="Trading sessions">
        <div className="sessions-list-head">
          <strong>
            {items.length} {items.length === 1 ? "session" : "sessions"}
          </strong>
          <button
            className="icon-button"
            aria-label="Refresh sessions"
            onClick={() => setReload((v) => v + 1)}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {items.map((s) => (
          <button
            key={s.id}
            className={`session-card ${s.id === selected ? "is-selected" : ""}`}
            aria-pressed={s.id === selected}
            onClick={() => {
              setSelected(s.id);
              if (window.innerWidth < 900)
                requestAnimationFrame(() =>
                  detailRef.current?.scrollIntoView({ behavior: "smooth" }),
                );
            }}
          >
            <div className="session-card-top">
              <strong>Session #{s.number}</strong>
              {s.status === "running" ? (
                <Badge tone="positive">Running</Badge>
              ) : (
                <span className={`pnl ${tone(s.net_pnl_usdt)}`}>
                  {usdt(s.net_pnl_usdt, true)}
                </span>
              )}
            </div>
            <span className="muted">
              {dateTime(s.started_at)} · {duration(s.duration_seconds)}
            </span>
            <span className="session-card-meta">
              {s.trades} trades
              {s.exits ? ` · ${s.wins}W / ${s.losses}L` : ""}
              {s.status === "ended" ? ` · ${s.end_label}` : ""}
            </span>
          </button>
        ))}
      </aside>
      <div className="sessions-detail" ref={detailRef}>
        {error && (
          <p role="alert" className="aegis-error">
            {error}
          </p>
        )}
        {loading && !detail && (
          <p className="muted">
            <LoaderCircle size={14} className="spin" /> Loading session…
          </p>
        )}
        {detail && <SessionDetail detail={detail} />}
      </div>
    </div>
  );
}

function SessionDetail({ detail }: { detail: Detail }) {
  const closed = detail.positions.filter((p) => p.status === "closed");
  return (
    <div className="session-detail">
      <header className="session-header">
        <div>
          <h2>Session #{detail.number}</h2>
          <p className="muted">
            {dateTime(detail.started_at)} →{" "}
            {detail.ended_at ? dateTime(detail.ended_at) : "now"} ·{" "}
            {duration(detail.duration_seconds)}
          </p>
        </div>
        <Badge tone={detail.status === "running" ? "positive" : "neutral"}>
          {detail.status === "running" ? "Running" : detail.end_label}
        </Badge>
      </header>
      <div className="session-kpis">
        <div className="session-kpi">
          <span>Net P&amp;L</span>
          <strong className={`pnl ${tone(detail.net_pnl_usdt)}`}>
            {usdt(detail.net_pnl_usdt, true)}
          </strong>
          <small className={`pnl ${tone(detail.net_pnl_pct)}`}>
            {pct(detail.net_pnl_pct)} of starting NAV
          </small>
        </div>
        <div className="session-kpi">
          <span>Portfolio value</span>
          <strong>{usdt(detail.end_nav_usdt)}</strong>
          <small>started at {usdt(detail.start_nav_usdt)}</small>
        </div>
        <div className="session-kpi">
          <span>Realized from trades</span>
          <strong className={`pnl ${tone(detail.realized_pnl_usdt)}`}>
            {usdt(detail.realized_pnl_usdt, true)}
          </strong>
          <small>
            {closed.length} closed · {detail.wins} won · {detail.losses} lost
          </small>
        </div>
        <div className="session-kpi">
          <span>Trades</span>
          <strong>{detail.trades}</strong>
          <small>
            {detail.entries} buys · {detail.exits} sells
          </small>
        </div>
      </div>
      <Panel
        title="Portfolio value during the session"
        subtitle="Recorded NAV at each market check · ▲ buy · ▼ sell"
      >
        <EquityChart series={detail.series} timeline={detail.timeline} />
      </Panel>
      <Panel
        title="What happened, step by step"
        subtitle="Every start, trade and stop with the value at that moment"
      >
        <ol className="session-timeline">
          {detail.timeline.map((item) => (
            <TimelineRow key={item.id} item={item} />
          ))}
        </ol>
        <p className="session-activity muted">
          Behind these trades the agent ran {detail.activity.market_checks ?? 0}{" "}
          market checks and {detail.activity.strategy_evaluations ?? 0} strategy
          evaluations ({detail.activity.holds ?? 0} hold,{" "}
          {detail.activity.blocked ?? 0} blocked by entry rules).
        </p>
      </Panel>
      {detail.positions.length > 0 && (
        <Panel title="Positions" subtitle="Each entry paired with its exit">
          <div className="table-wrap">
            <table className="session-positions">
              <thead>
                <tr>
                  <th>Asset · strategy</th>
                  <th>Bought</th>
                  <th>Sold</th>
                  <th>Held</th>
                  <th className="num">Result</th>
                </tr>
              </thead>
              <tbody>
                {detail.positions.map((p) => (
                  <tr key={`${p.asset}-${p.entry_at}`}>
                    <td>
                      <strong>{p.asset}</strong>
                      <small>{strategyName(p.strategy_id)}</small>
                    </td>
                    <td>
                      {price(p.entry_price_usdt)} USDT
                      <small>
                        {clock(p.entry_at)} · {usdt(p.cost_usdt)}
                      </small>
                    </td>
                    <td>
                      {p.exit_at ? `${price(p.exit_price_usdt)} USDT` : "Open"}
                      <small>
                        {p.exit_at
                          ? `${clock(p.exit_at)} · ${p.exit_reason ?? ""}`
                          : p.status === "partial"
                            ? "partly sold"
                            : "still held after this session"}
                      </small>
                    </td>
                    <td>{duration(p.holding_seconds)}</td>
                    <td className="num">
                      <strong className={`pnl ${tone(p.realized_pnl_usdt)}`}>
                        {usdt(p.realized_pnl_usdt, true)}
                      </strong>
                      <small className={`pnl ${tone(p.return_pct)}`}>
                        {pct(p.return_pct)}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      <Panel
        title="Strategy & settings"
        subtitle={`Settings ${detail.settings_source}`}
      >
        {detail.strategy_breakdown.length > 0 && (
          <div className="session-strategies">
            {detail.strategy_breakdown.map((s) => (
              <div key={s.strategy_id}>
                <span>{strategyName(s.strategy_id)}</span>
                <strong className={`pnl ${tone(s.realized_pnl_usdt)}`}>
                  {usdt(s.realized_pnl_usdt, true)}
                </strong>
                <small>{s.positions} positions</small>
              </div>
            ))}
          </div>
        )}
        <dl className="session-settings">
          <Setting
            label="Strategies enabled"
            value={(detail.settings.active_strategies as string[] | undefined)
              ?.map((id) => strategyName(id))
              .join(", ")}
          />
          <Setting
            label="Target assets"
            value={(
              detail.settings.target_assets as string[] | undefined
            )?.join(", ")}
          />
          <Setting label="Risk level" value={detail.settings.risk_level} />
          <Setting
            label="Position size"
            value={
              detail.settings.position_size_usdt
                ? `${detail.settings.position_size_usdt} USDT`
                : detail.settings.position_size_pct
                  ? `${detail.settings.position_size_pct}% of NAV`
                  : undefined
            }
          />
          <Setting
            label="Stop-loss / take-profit"
            value={
              detail.settings.stop_loss_pct
                ? `${detail.settings.stop_loss_pct}% / ${detail.settings.take_profit_pct}%`
                : undefined
            }
          />
          <Setting
            label="Check every"
            value={
              detail.settings.tick_seconds
                ? `${detail.settings.tick_seconds}s`
                : undefined
            }
          />
        </dl>
      </Panel>
    </div>
  );
}

function Setting({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value === undefined || value === null || value === ""
          ? "—"
          : String(value)}
      </dd>
    </div>
  );
}

const ICONS = {
  start: CirclePlay,
  stop: CircleStop,
  buy: ArrowUpRight,
  sell: ArrowDownRight,
  risk: ShieldAlert,
  settings: Settings2,
};

function TimelineRow({ item }: { item: TimelineItem }) {
  const Icon = ICONS[item.kind] ?? Settings2;
  const trade = item.kind === "buy" || item.kind === "sell";
  return (
    <li className={`session-step kind-${item.kind}`}>
      <span className="session-step-icon" aria-hidden="true">
        <Icon size={15} />
      </span>
      <div className="session-step-body">
        <div className="session-step-head">
          <strong>{item.title}</strong>
          <time dateTime={new Date(item.at * 1000).toISOString()}>
            {clock(item.at)}
          </time>
        </div>
        {trade && (
          <div className="session-step-values">
            <span>
              <small>Price</small>
              {price(item.price_usdt)} USDT
            </span>
            <span>
              <small>Amount</small>
              {quantity(item.quantity)} {item.asset}
            </span>
            <span>
              <small>{item.kind === "buy" ? "Spent" : "Received"}</small>
              {usdt(item.notional_usdt)}
            </span>
            {item.kind === "sell" && (
              <span>
                <small>Result</small>
                <b className={`pnl ${tone(item.realized_pnl_usdt)}`}>
                  {usdt(item.realized_pnl_usdt, true)}
                </b>
              </span>
            )}
            {item.confidence && (
              <span>
                <small>Confidence</small>
                {Math.round(Number(item.confidence) * 100)}%
              </span>
            )}
          </div>
        )}
        {(item.detail || item.strategy_id) && (
          <p>
            {trade && item.kind === "buy" && item.strategy_id && (
              <Badge>
                {strategyName(item.strategy_id, item.strategy_name)}
              </Badge>
            )}{" "}
            {item.detail}
          </p>
        )}
        {!trade && item.nav_usdt && (
          <p className="muted">Portfolio value then: {usdt(item.nav_usdt)}</p>
        )}
      </div>
    </li>
  );
}

function EquityChart({
  series,
  timeline,
}: {
  series: { at: number; nav_usdt: string }[];
  timeline: TimelineItem[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Draw at the container's real width so axis text stays 11px on phones and desktops.
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(260, Math.round(entry.contentRect.width))),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [series.length >= 2]); // The box only exists once there is a line to draw.
  const W = width,
    H = width < 520 ? 200 : 240,
    pad = { l: 60, r: 12, t: 14, b: 26 };
  const trades = timeline.filter((t) => t.kind === "buy" || t.kind === "sell");
  const geometry = useMemo(() => {
    if (series.length < 2) return null;
    const xs = series.map((p) => p.at),
      ys = series.map((p) => Number(p.nav_usdt));
    const x0 = Math.min(...xs, ...trades.map((t) => t.at)),
      x1 = Math.max(...xs, ...trades.map((t) => t.at));
    let y0 = Math.min(...ys),
      y1 = Math.max(...ys);
    const span = y1 - y0 || Math.max(Math.abs(y1) * 0.001, 0.01);
    y0 -= span * 0.15;
    y1 += span * 0.15;
    const x = (v: number) =>
      pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
    const y = (v: number) =>
      pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    const navAt = (at: number) => {
      let best = series[0];
      for (const p of series) if (p.at <= at) best = p;
      return Number(best.nav_usdt);
    };
    return { x, y, x0, x1, y0, y1, navAt };
  }, [series, trades, W, H]);
  if (!geometry)
    return (
      <p className="muted session-chart-empty">
        Not enough recorded market checks in this session to draw a chart.
      </p>
    );
  const { x, y, x0, x1, y0, y1, navAt } = geometry;
  const path = series
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(Number(p.nav_usdt)).toFixed(1)}`,
    )
    .join("");
  const ticks = [y0 + (y1 - y0) * 0.15, (y0 + y1) / 2, y1 - (y1 - y0) * 0.15];
  const point = hover === null ? null : series[hover];
  const nearbyTrades = point
    ? trades.filter((t) => Math.abs(x(t.at) - x(point.at)) < 8)
    : [];
  const onMove = (event: React.PointerEvent) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    series.forEach((p, i) => {
      if (Math.abs(x(p.at) - px) < Math.abs(x(series[best].at) - px)) best = i;
    });
    setHover(best);
  };
  return (
    <div className="session-chart" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Portfolio value from ${usdt(series[0].nav_usdt)} to ${usdt(series[series.length - 1].nav_usdt)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="grid"
              x1={pad.l}
              x2={W - pad.r}
              y1={y(t)}
              y2={y(t)}
            />
            <text className="axis" x={pad.l - 8} y={y(t) + 4} textAnchor="end">
              {t.toFixed(t > 1000 ? 0 : 3)}
            </text>
          </g>
        ))}
        <text className="axis" x={pad.l} y={H - 6}>
          {clock(x0)}
        </text>
        <text className="axis" x={W - pad.r} y={H - 6} textAnchor="end">
          {clock(x1)}
        </text>
        <path
          className="nav-area"
          d={`${path}L${x(series[series.length - 1].at)},${H - pad.b}L${x(series[0].at)},${H - pad.b}Z`}
        />
        <path className="nav-line" d={path} />
        {trades.map((t) => {
          const cx = x(t.at),
            cy = y(navAt(t.at));
          return t.kind === "buy" ? (
            <path
              key={t.id}
              className="marker buy"
              d={`M${cx},${cy - 7}L${cx + 6},${cy + 4}L${cx - 6},${cy + 4}Z`}
            />
          ) : (
            <path
              key={t.id}
              className="marker sell"
              d={`M${cx},${cy + 7}L${cx + 6},${cy - 4}L${cx - 6},${cy - 4}Z`}
            />
          );
        })}
        {point && (
          <g>
            <line
              className="crosshair"
              x1={x(point.at)}
              x2={x(point.at)}
              y1={pad.t}
              y2={H - pad.b}
            />
            <circle
              className="focus-dot"
              cx={x(point.at)}
              cy={y(Number(point.nav_usdt))}
              r={4.5}
            />
          </g>
        )}
      </svg>
      {point && (
        <div
          className="session-tooltip"
          style={{
            left: `${(x(point.at) / W) * 100}%`,
            transform: `translateX(${x(point.at) > W * 0.7 ? "-105%" : "8px"})`,
          }}
          role="status"
        >
          <strong>{clock(point.at)}</strong>
          <span>Portfolio {usdt(point.nav_usdt)}</span>
          {nearbyTrades.map((t) => (
            <span key={t.id}>
              {t.title} @ {price(t.price_usdt)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
