import { useEffect, useMemo, useRef, useState } from "react";
import type { Amount, Candle, ChartIndicators } from "./types";

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

export interface ChartViewport {
  bars: number;
  offset: number;
}
export interface ChartLevel {
  id: string;
  label: string;
  price: Amount;
  kind: "entry" | "stop" | "mark" | "candidate";
}
export interface ChartMarker {
  id: string;
  timestamp: string;
  price: Amount;
  label: string;
  side: "BUY" | "SELL";
  detail: string;
}

export function CandleChart({
  candles,
  limit = 72,
  timeframe = "1h",
  series,
  view,
  onViewChange,
  showEma12 = true,
  showEma26 = false,
  showVolume = true,
  showRsi = false,
  showMacd = false,
  levels = [],
  markers = [],
}: {
  candles: Candle[];
  limit?: number;
  timeframe?: string;
  series?: ChartIndicators;
  view?: ChartViewport;
  onViewChange?: (view: ChartViewport) => void;
  showEma12?: boolean;
  showEma26?: boolean;
  showVolume?: boolean;
  showRsi?: boolean;
  showMacd?: boolean;
  levels?: ChartLevel[];
  markers?: ChartMarker[];
}) {
  const { ref, width: chartWidth } = useChartWidth();
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; offset: number } | null>(null);
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);
  const total = candles.length;
  const count = Math.min(total, Math.max(1, Math.round(view?.bars ?? limit)));
  const offset = Math.min(
    Math.max(0, total - count),
    Math.max(0, Math.round(view?.offset ?? 0)),
  );
  const end = total - offset,
    start = Math.max(0, end - count);
  const rows = useMemo(() => candles.slice(start, end), [candles, start, end]);
  const legacy = useMemo(
    () => chartEma(candles).slice(start, end),
    [candles, start, end],
  );
  const pointsByTime = useMemo(
    () =>
      new Map(
        (series?.points ?? []).map((point) => [
          Date.parse(point.timestamp),
          point,
        ]),
      ),
    [series],
  );
  const left = 12,
    right = Math.max(90, chartWidth - 76),
    plotWidth = Math.max(1, right - left);
  const step = plotWidth / Math.max(1, rows.length);
  const height = 320 + (showRsi ? 110 : 0) + (showMacd ? 120 : 0);
  const change = (bars: number, nextOffset: number) =>
    onViewChange?.({
      bars: Math.min(total, Math.max(Math.min(12, total), Math.round(bars))),
      offset: Math.max(0, Math.round(nextOffset)),
    });
  useEffect(() => {
    setHover(null);
  }, [count, offset, timeframe]);
  useEffect(() => {
    const node = svg.current;
    if (!node || !onViewChange) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY))
        change(count, offset + event.deltaX / step);
      else if (event.deltaY !== 0)
        change(count * (event.deltaY > 0 ? 1.2 : 0.8), offset);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [count, offset, total, step, onViewChange]);
  const computed = useMemo(() => {
    if (!rows.length) return null;
    const emas = rows.map((bar, index) => {
      const measured = pointsByTime.get(Date.parse(bar.timestamp));
      return {
        fast: series ? (measured?.ema12 ?? null) : legacy[index],
        slow: measured?.ema26 ?? null,
      };
    });
    const visiblePrices = [
      ...rows.flatMap((bar) => [Number(bar.low), Number(bar.high)]),
      ...emas
        .flatMap((ema) => [
          showEma12 ? ema.fast : null,
          showEma26 ? ema.slow : null,
        ])
        .filter((value): value is number => value !== null),
      ...levels
        .map((level) => Number(level.price))
        .filter((value) => Number.isFinite(value) && value > 0),
    ];
    const low = Math.min(...visiblePrices),
      high = Math.max(...visiblePrices),
      pad = (high - low) * 0.12 || high * 0.01;
    return {
      min: Math.max(0, low - pad),
      max: high + pad,
      emas,
      volume: Math.max(...rows.map((bar) => Number(bar.volume))) || 1,
    };
  }, [rows, pointsByTime, series, legacy, levels, showEma12, showEma26]);
  if (!computed)
    return (
      <div className="empty" ref={ref}>
        No valid candle history available.
      </div>
    );
  const { min, max, emas, volume } = computed;
  const priceY = (value: Amount) =>
    226 - ((Number(value) - min) * 198) / (max - min || 1);
  const activeIndex = Math.min(
    hover?.index ?? rows.length - 1,
    rows.length - 1,
  );
  const active = rows[activeIndex];
  const activePoint = pointsByTime.get(Date.parse(active.timestamp));
  const tickCount = chartWidth < 480 ? 3 : 4;
  const x = (index: number) => left + (index + 0.5) * step;
  const format = (value: number) =>
    value.toLocaleString("en-US", {
      maximumFractionDigits:
        Math.abs(value) < 1 ? 6 : Math.abs(value) < 100 ? 3 : 1,
    });
  const line = (
    values: (number | null | undefined)[],
    y: (value: number) => number,
  ) =>
    values
      .map((value, index) =>
        value == null || !Number.isFinite(value)
          ? null
          : `${x(index)},${y(value)}`,
      )
      .filter(Boolean)
      .join(" ");
  const fastPoints = line(
      emas.map((ema) => ema.fast),
      priceY,
    ),
    slowPoints = line(
      emas.map((ema) => ema.slow),
      priceY,
    );
  const measured = rows.map((bar) =>
    pointsByTime.get(Date.parse(bar.timestamp)),
  );
  const rsiTop = 320,
    macdTop = 320 + (showRsi ? 110 : 0);
  const rsiY = (value: number) => rsiTop + 94 - value * 0.65;
  const macdValues = measured
    .flatMap((point) => [point?.macd, point?.signal, point?.histogram])
    .filter(
      (value): value is number => value != null && Number.isFinite(value),
    );
  const macdRange = Math.max(...macdValues.map(Math.abs), 0.000001) * 1.15;
  const macdY = (value: number) => macdTop + 70 - (value / macdRange) * 35;
  const visibleMarkers = markers
    .map((marker) => ({
      marker,
      index: rows.findIndex(
        (bar) =>
          Date.parse(bar.timestamp) <= Date.parse(marker.timestamp) &&
          Date.parse(marker.timestamp) <= Date.parse(bar.closed_at),
      ),
    }))
    .filter((item) => item.index >= 0);
  const labeledY: number[] = [];
  return (
    <div
      className={`candle-wrap ${onViewChange ? "interactive-candles" : ""}`}
      ref={ref}
    >
      <div className="ohlc-line">
        <span>
          {new Date(active.timestamp).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
          })}{" "}
          UTC
        </span>
        {(["open", "high", "low", "close"] as const).map((key) => (
          <span key={key}>
            <b>{key[0].toUpperCase()}</b>{" "}
            {Number(active[key]).toLocaleString("en-US", {
              maximumFractionDigits: 4,
            })}
          </span>
        ))}
      </div>
      <svg
        ref={svg}
        viewBox={`0 0 ${chartWidth} ${height}`}
        className="candles"
        tabIndex={0}
        role="img"
        aria-label={`${timeframe === "1h" ? "Hourly" : timeframe === "4h" ? "Four-hour" : "Daily"} candlestick and base-volume chart. Arrow keys inspect candles.${onViewChange ? " Drag to pan; wheel or plus/minus to zoom; Home follows latest." : ""}`}
        data-visible-bars={rows.length}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            if (event.shiftKey && onViewChange)
              change(count, offset - direction * 12);
            else {
              const index = Math.max(
                0,
                Math.min(rows.length - 1, activeIndex + direction),
              );
              setHover({ index, y: priceY(rows[index].close) });
            }
          } else if (
            onViewChange &&
            ["+", "=", "-", "Home"].includes(event.key)
          ) {
            event.preventDefault();
            if (event.key === "Home") change(count, 0);
            else change(count * (event.key === "-" ? 1.25 : 0.8), offset);
          }
        }}
        onPointerDown={(event) => {
          if (!onViewChange || event.button !== 0) return;
          event.currentTarget.focus();
          drag.current = { x: event.clientX, offset };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const pointerX =
            ((event.clientX - rect.left) / rect.width) * chartWidth;
          const pointerY = ((event.clientY - rect.top) / rect.height) * height;
          if (drag.current && onViewChange)
            change(
              count,
              drag.current.offset + (event.clientX - drag.current.x) / step,
            );
          setHover({
            index: Math.max(
              0,
              Math.min(rows.length - 1, Math.floor((pointerX - left) / step)),
            ),
            y: pointerY,
          });
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerLeave={() => {
          if (!drag.current) setHover(null);
        }}
      >
        {[0, 1, 2, 3, 4].map((index) => (
          <g key={index}>
            <line
              x1={left}
              x2={right}
              y1={28 + index * 49.5}
              y2={28 + index * 49.5}
              stroke="var(--border)"
              strokeDasharray="3 5"
            />
            <text
              x={right + 10}
              y={32 + index * 49.5}
              fill="var(--muted)"
              fontSize="12"
            >
              {format(max - (index * (max - min)) / 4)}
            </text>
          </g>
        ))}
        {rows.map((bar, index) => {
          const color =
            Number(bar.close) >= Number(bar.open)
              ? "var(--positive)"
              : "var(--negative)";
          return (
            <g key={bar.timestamp} data-candle={bar.timestamp}>
              <line
                x1={x(index)}
                x2={x(index)}
                y1={priceY(bar.high)}
                y2={priceY(bar.low)}
                stroke={color}
                strokeWidth="1"
              />
              <rect
                x={x(index) - step * 0.28}
                y={Math.min(priceY(bar.open), priceY(bar.close))}
                width={Math.max(1, step * 0.56)}
                height={Math.max(
                  1.2,
                  Math.abs(priceY(bar.open) - priceY(bar.close)),
                )}
                fill={color}
              />
              {showVolume && (
                <rect
                  x={x(index) - step * 0.28}
                  y={285 - (Number(bar.volume) / volume) * 35}
                  width={Math.max(1, step * 0.56)}
                  height={(Number(bar.volume) / volume) * 35}
                  fill={color}
                  opacity="0.32"
                />
              )}
            </g>
          );
        })}
        {showEma12 && (
          <polyline
            points={fastPoints}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
          />
        )}
        {showEma26 && (
          <polyline
            points={slowPoints}
            fill="none"
            stroke="#81cbe6"
            strokeWidth="1.4"
          />
        )}
        {levels
          .filter(
            (level) =>
              Number(level.price) > 0 && Number.isFinite(Number(level.price)),
          )
          .map((level) => {
            const actualY = priceY(level.price);
            let labelY = Math.max(40, Math.min(213, actualY - 6));
            while (
              labeledY.some((value) => Math.abs(value - labelY) < 16) &&
              labelY < 208
            )
              labelY += 16;
            labeledY.push(labelY);
            const color =
              level.kind === "stop"
                ? "var(--negative)"
                : level.kind === "entry"
                  ? "#81cbe6"
                  : "var(--muted)";
            return (
              <g key={level.id} className="chart-level" data-level={level.kind}>
                <title>
                  {level.label}: {level.price}
                </title>
                <line
                  x1={left}
                  x2={right}
                  y1={actualY}
                  y2={actualY}
                  stroke={color}
                  strokeDasharray="5 5"
                  opacity="0.8"
                />
                <text
                  x={left + 7}
                  y={labelY}
                  fill={color}
                  fontSize="12"
                  stroke="var(--panel)"
                  strokeWidth="4"
                  paintOrder="stroke"
                >
                  {level.label} {format(Number(level.price))}
                </text>
              </g>
            );
          })}
        {visibleMarkers.map(({ marker, index }) => (
          <g
            key={marker.id}
            className="trade-marker"
            data-marker={marker.label}
          >
            <title>{marker.detail}</title>
            <circle
              cx={x(index)}
              cy={Math.max(35, Math.min(220, priceY(marker.price)))}
              r="5"
              fill={
                marker.side === "BUY" ? "var(--positive)" : "var(--negative)"
              }
              stroke="var(--panel)"
              strokeWidth="2"
            />
            <text
              x={Math.min(right - 15, Math.max(left + 15, x(index)))}
              y={marker.side === "BUY" ? 246 : 17}
              textAnchor="middle"
              fill={
                marker.side === "BUY" ? "var(--positive)" : "var(--negative)"
              }
              fontSize="12"
            >
              {marker.label}
            </text>
          </g>
        ))}
        {Array.from({ length: tickCount }, (_, index) => (
          <text
            key={index}
            x={left + (index * plotWidth) / (tickCount - 1)}
            y="311"
            fill="var(--muted)"
            fontSize="12"
            textAnchor={
              index === tickCount - 1 ? "end" : index === 0 ? "start" : "middle"
            }
          >
            {new Date(
              rows[Math.floor((index * (rows.length - 1)) / (tickCount - 1))]
                .timestamp,
            ).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })}
          </text>
        ))}
        {showRsi && (
          <g className="rsi-panel">
            <line
              x1={left}
              x2={right}
              y1={rsiTop + 7}
              y2={rsiTop + 7}
              stroke="var(--border)"
            />
            <text x={left} y={rsiTop + 22} fill="var(--muted)" fontSize="12">
              RSI 14 ·{" "}
              {activePoint?.rsi14 == null
                ? "unavailable"
                : activePoint.rsi14.toFixed(2)}
            </text>
            {[30, 70].map((value) => (
              <g key={value}>
                <line
                  x1={left}
                  x2={right}
                  y1={rsiY(value)}
                  y2={rsiY(value)}
                  stroke="var(--border)"
                  strokeDasharray="3 5"
                />
                <text
                  x={right + 10}
                  y={rsiY(value) + 4}
                  fill="var(--muted)"
                  fontSize="12"
                >
                  {value}
                </text>
              </g>
            ))}
            <polyline
              points={line(
                measured.map((point) => point?.rsi14),
                rsiY,
              )}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.5"
            />
          </g>
        )}
        {showMacd && (
          <g className="macd-panel">
            <line
              x1={left}
              x2={right}
              y1={macdTop + 7}
              y2={macdTop + 7}
              stroke="var(--border)"
            />
            <text x={left} y={macdTop + 23} fill="var(--muted)" fontSize="12">
              MACD 12/26/9 ·{" "}
              {activePoint?.macd == null
                ? "unavailable"
                : format(activePoint.macd)}
            </text>
            <line
              x1={left}
              x2={right}
              y1={macdY(0)}
              y2={macdY(0)}
              stroke="var(--border)"
            />
            <text
              x={right + 10}
              y={macdY(0) + 4}
              fill="var(--muted)"
              fontSize="12"
            >
              0
            </text>
            {measured.map((point, index) =>
              point?.histogram == null ? null : (
                <rect
                  key={rows[index].timestamp}
                  x={x(index) - step * 0.27}
                  width={Math.max(1, step * 0.54)}
                  y={Math.min(macdY(0), macdY(point.histogram))}
                  height={Math.max(
                    0.5,
                    Math.abs(macdY(0) - macdY(point.histogram)),
                  )}
                  fill={
                    point.histogram >= 0 ? "var(--positive)" : "var(--negative)"
                  }
                  opacity="0.6"
                />
              ),
            )}
            <polyline
              points={line(
                measured.map((point) => point?.macd),
                macdY,
              )}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.4"
            />
            <polyline
              points={line(
                measured.map((point) => point?.signal),
                macdY,
              )}
              fill="none"
              stroke="#81cbe6"
              strokeWidth="1.4"
            />
          </g>
        )}
        {hover && (
          <g className="chart-crosshair">
            <line
              x1={x(activeIndex)}
              x2={x(activeIndex)}
              y1="24"
              y2={height - 15}
              stroke="var(--muted)"
              strokeDasharray="3 4"
            />
            {hover.y >= 28 && hover.y <= 226 && (
              <>
                <line
                  x1={left}
                  x2={right}
                  y1={hover.y}
                  y2={hover.y}
                  stroke="var(--muted)"
                  strokeDasharray="3 4"
                />
                <rect
                  x={right + 5}
                  y={hover.y - 10}
                  width="70"
                  height="20"
                  rx="4"
                  fill="var(--raised)"
                />
                <text
                  x={right + 10}
                  y={hover.y + 4}
                  fill="var(--text)"
                  fontSize="12"
                >
                  {format(min + ((226 - hover.y) / 198) * (max - min))}
                </text>
              </>
            )}
          </g>
        )}
      </svg>
      <div className="chart-legend">
        {showEma12 && (
          <>
            <span className="legend-line" />
            {fastPoints ? "EMA 12" : "EMA 12 unavailable: fewer than 12 bars"}
          </>
        )}
        {showEma26 && (
          <>
            <span className="legend-line slow" />
            EMA 26
          </>
        )}
        {showVolume && (
          <>
            <span className="volume-key" />
            Base asset volume
          </>
        )}
        <span className="muted right">
          {onViewChange
            ? `Bars ${start + 1}–${end} of ${total} · ${offset ? "historical view" : "following latest"}`
            : `Closed ${timeframe} candles · hover or use arrow keys`}
        </span>
      </div>
      {(showRsi || showMacd) && series?.reason && (
        <p className="desk-indicator-note">{series.reason}</p>
      )}
    </div>
  );
}
