import { useEffect, useMemo, useState } from "react";
import type { Amount, Candle } from "./types";

// The SVG coordinate system follows its container. Axis labels therefore stay
// at their declared reading size instead of shrinking with a desktop viewBox.
function useChartWidth() {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(680);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, width };
}

function chartEma(candles: Candle[], period = 12): (number | null)[] {
  let value = 0;
  return candles.map((candle, index) => {
    const close = Number(candle.close);
    if (index < period) value += close / period;
    else value = close * (2 / (period + 1)) + value * (1 - 2 / (period + 1));
    return index < period - 1 ? null : value;
  });
}

export function Sparkline({
  values,
  positive = true,
}: {
  values: Amount[];
  positive?: boolean;
}) {
  if (values.length < 2) return <span className="muted">—</span>;
  const numbers = values.map(Number),
    low = Math.min(...numbers),
    span = Math.max(...numbers) - low || 1;
  const points = numbers
    .map(
      (n, i) =>
        `${(i * 95) / (numbers.length - 1)},${26 - ((n - low) * 22) / span}`,
    )
    .join(" ");
  return (
    <svg viewBox="0 0 96 30" className="sparkline" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={positive ? "var(--positive)" : "var(--negative)"}
        strokeWidth="1.6"
      />
    </svg>
  );
}

export function EquityChart({
  rows,
}: {
  rows: { at: string; equity: Amount }[];
}) {
  const { ref, width } = useChartWidth();
  const left = 12,
    right = width - 72,
    plotWidth = Math.max(1, right - left);
  const values = rows.map((r) => Number(r.equity));
  const minimum = Math.min(...values, 10000) - 2,
    maximum = Math.max(...values, 10000) + 2,
    range = maximum - minimum;
  const points = rows
    .map(
      (r, i) =>
        `${left + (i * plotWidth) / Math.max(1, rows.length - 1)},${225 - ((Number(r.equity) - minimum) * 175) / range}`,
    )
    .join(" ");
  return (
    <div className="equity-chart" ref={ref}>
      <svg
        viewBox={`0 0 ${width} 270`}
        role="img"
        aria-label={`Recorded simulation equity history, ${rows.length} snapshots`}
      >
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line
              x1={left}
              x2={right}
              y1={48 + i * 59}
              y2={48 + i * 59}
              stroke="var(--border)"
              strokeDasharray="3 5"
            />
            <text
              x={right + 10}
              y={53 + i * 59}
              fill="var(--muted)"
              fontSize="12"
            >
              {(maximum - (i * range) / 3).toFixed(0)}
            </text>
          </g>
        ))}
        {rows.length > 0 && (
          <polyline
            points={points}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
          />
        )}
        {rows.map((r, i) => (
          <circle
            key={i}
            cx={left + (i * plotWidth) / Math.max(1, rows.length - 1)}
            cy={225 - ((Number(r.equity) - minimum) * 175) / range}
            r="3"
            fill="var(--accent)"
          >
            <title>
              {r.at}: ${Number(r.equity).toFixed(4)} simulated equity
            </title>
          </circle>
        ))}
        <text x={left} y="259" fill="var(--muted)" fontSize="12">
          {width < 480 ? "First mark" : "First recorded mark"}
        </text>
        <text
          x={right}
          y="259"
          fill="var(--muted)"
          fontSize="12"
          textAnchor="end"
        >
          Latest mark
        </text>
      </svg>
      {rows.length < 3 && (
        <div className="chart-empty-note">
          The equity curve grows from recorded marks and simulated fills.
        </div>
      )}
    </div>
  );
}

export function CandleChart({
  candles,
  limit = 72,
  timeframe = "1h",
}: {
  candles: Candle[];
  limit?: number;
  timeframe?: string;
}) {
  const { ref, width: chartWidth } = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);
  const rows = useMemo(() => candles.slice(-limit), [candles, limit]);
  const emas = useMemo(() => chartEma(candles).slice(-limit), [candles, limit]);
  const left = 12,
    right = chartWidth - 76;
  const plotWidth = Math.max(1, right - left);
  const computed = useMemo(() => {
    if (!rows.length) return null;
    const availableEmas = emas.filter(
      (value): value is number => value !== null,
    );
    const low = Math.min(...rows.map((c) => Number(c.low)), ...availableEmas),
      high = Math.max(...rows.map((c) => Number(c.high)), ...availableEmas);
    const pad = (high - low) * 0.12 || high * 0.01;
    const min = low - pad,
      max = high + pad;
    const width = plotWidth / rows.length;
    const points = emas
      .map((ema, i) =>
        ema === null
          ? null
          : `${left + (i + 0.5) * width},${226 - ((ema - min) * 198) / (max - min)}`,
      )
      .filter((point) => point !== null)
      .join(" ");
    return {
      min,
      max,
      width,
      points,
      volume: Math.max(...rows.map((c) => Number(c.volume))) || 1,
    };
  }, [rows, emas, plotWidth]);
  if (!computed)
    return (
      <div className="empty" ref={ref}>
        No valid candle history available.
      </div>
    );
  const { min, max, width, points, volume } = computed;
  const y = (value: Amount) =>
    226 - ((Number(value) - min) * 198) / (max - min);
  const activeIndex = Math.min(hover ?? rows.length - 1, rows.length - 1);
  const active = rows[activeIndex];
  const tickCount = chartWidth < 480 ? 3 : 4;
  return (
    <div className="candle-wrap" ref={ref}>
      <div className="ohlc-line">
        <span>
          {new Date(active.timestamp).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            timeZone: "UTC",
          })}{" "}
          UTC
        </span>
        {(["open", "high", "low", "close"] as const).map((k) => (
          <span key={k}>
            <b>{k[0].toUpperCase()}</b>{" "}
            {Number(active[k]).toLocaleString("en-US", {
              maximumFractionDigits: 2,
            })}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${chartWidth} 320`}
        className="candles"
        tabIndex={0}
        role="img"
        aria-label={`${timeframe === "1h" ? "Hourly" : timeframe === "4h" ? "Four-hour" : "Daily"} candlestick and base-volume chart. Arrow keys inspect candles.`}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault();
            setHover((v) =>
              Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  (v ?? rows.length - 1) + (e.key === "ArrowLeft" ? -1 : 1),
                ),
              ),
            );
          }
        }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * chartWidth;
          setHover(
            Math.max(
              0,
              Math.min(rows.length - 1, Math.floor((x - left) / width)),
            ),
          );
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1={left}
              x2={right}
              y1={28 + i * 49.5}
              y2={28 + i * 49.5}
              stroke="var(--border)"
              strokeDasharray="3 5"
            />
            <text
              x={right + 10}
              y={32 + i * 49.5}
              fill="var(--muted)"
              fontSize="12"
            >
              {(max - (i * (max - min)) / 4).toLocaleString("en-US", {
                maximumFractionDigits: 1,
              })}
            </text>
          </g>
        ))}
        {rows.map((c, i) => {
          const x = left + (i + 0.5) * width,
            up = Number(c.close) >= Number(c.open),
            color = up ? "var(--positive)" : "var(--negative)";
          return (
            <g key={c.timestamp}>
              <line
                x1={x}
                x2={x}
                y1={y(c.high)}
                y2={y(c.low)}
                stroke={color}
                strokeWidth="1"
              />
              <rect
                x={x - width * 0.28}
                y={Math.min(y(c.open), y(c.close))}
                width={Math.max(1, width * 0.56)}
                height={Math.max(1.2, Math.abs(y(c.open) - y(c.close)))}
                fill={color}
              />
              <rect
                x={x - width * 0.28}
                y={285 - (Number(c.volume) / volume) * 35}
                width={Math.max(1, width * 0.56)}
                height={(Number(c.volume) / volume) * 35}
                fill={color}
                opacity="0.27"
              />
            </g>
          );
        })}
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.4"
          opacity="0.9"
        />
        {hover !== null && (
          <line
            x1={left + (activeIndex + 0.5) * width}
            x2={left + (activeIndex + 0.5) * width}
            y1="24"
            y2="286"
            stroke="var(--muted)"
            strokeDasharray="3 3"
          />
        )}
        {Array.from({ length: tickCount }, (_, i) => (
          <text
            key={i}
            x={left + (i * plotWidth) / (tickCount - 1)}
            y="311"
            fill="var(--muted)"
            fontSize="12"
            textAnchor={
              i === tickCount - 1 ? "end" : i === 0 ? "start" : "middle"
            }
          >
            {new Date(
              rows[
                Math.min(
                  rows.length - 1,
                  Math.floor((i * (rows.length - 1)) / (tickCount - 1)),
                )
              ].timestamp,
            ).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
          </text>
        ))}
      </svg>
      <div className="chart-legend">
        <span className="legend-line" />
        {points ? "EMA 12" : "EMA 12 unavailable: fewer than 12 bars"}{" "}
        <span className="volume-key" />
        Base asset volume{" "}
        <span className="muted right">
          Closed {timeframe} candles · hover or use arrow keys
        </span>
      </div>
    </div>
  );
}
