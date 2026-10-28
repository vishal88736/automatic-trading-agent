import { useMemo, useState } from 'react';
import type { Amount, Candle } from './types';

export function Sparkline({ values, positive = true }: { values: Amount[]; positive?: boolean }) {
  if (values.length < 2) return <span className="muted">—</span>;
  const numbers = values.map(Number), low = Math.min(...numbers), span = Math.max(...numbers) - low || 1;
  const points = numbers.map((n, i) => `${i * 95 / (numbers.length - 1)},${26 - (n - low) * 22 / span}`).join(' ');
  return <svg viewBox="0 0 96 30" className="sparkline" aria-hidden="true"><polyline points={points} fill="none" stroke={positive ? 'var(--positive)' : 'var(--negative)'} strokeWidth="1.6" /></svg>;
}

export function EquityChart({ rows }: { rows: { at: string; equity: Amount }[] }) {
  const values = rows.map(r => Number(r.equity));
  const minimum = Math.min(...values, 10000) - 2, maximum = Math.max(...values, 10000) + 2, range = maximum - minimum;
  const points = rows.map((r, i) => `${54 + i * 850 / Math.max(1, rows.length - 1)},${225 - (Number(r.equity) - minimum) * 175 / range}`).join(' ');
  return <div className="equity-chart"><svg viewBox="0 0 980 270" role="img" aria-label={`Recorded simulation equity history, ${rows.length} snapshots`}>
    {[0, 1, 2, 3].map(i => <g key={i}><line x1="54" x2="914" y1={48 + i * 59} y2={48 + i * 59} stroke="var(--border)" strokeDasharray="3 5"/><text x="924" y={53 + i * 59} fill="var(--muted)" fontSize="11">{(maximum - i * range / 3).toFixed(0)}</text></g>)}
    {rows.length > 0 && <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="2"/>}
    {rows.map((r, i) => <circle key={i} cx={54 + i * 850 / Math.max(1, rows.length - 1)} cy={225 - (Number(r.equity) - minimum) * 175 / range} r="3" fill="var(--accent)"><title>{r.at}: ${Number(r.equity).toFixed(4)} simulated equity</title></circle>)}
    <text x="54" y="259" fill="var(--muted)" fontSize="11">First recorded mark</text><text x="820" y="259" fill="var(--muted)" fontSize="11">Latest mark</text>
  </svg>{rows.length < 3 && <div className="chart-empty-note">The equity curve grows from recorded marks and simulated fills.</div>}</div>;
}

export function CandleChart({ candles, limit = 72 }: { candles: Candle[]; limit?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = candles.slice(-limit);
  const computed = useMemo(() => {
    if (!rows.length) return null;
    const low = Math.min(...rows.map(c => Number(c.low))), high = Math.max(...rows.map(c => Number(c.high)));
    const pad = (high - low) * 0.12 || high * 0.01;
    const min = low - pad, max = high + pad;
    const width = 860 / rows.length;
    let ema = Number(rows[0].close);
    const points = rows.map((c, i) => { ema = Number(c.close) * (2 / 13) + ema * (11 / 13); return `${42 + (i + 0.5) * width},${226 - (ema - min) * 198 / (max - min)}`; }).join(' ');
    return { min, max, width, points, volume: Math.max(...rows.map(c => Number(c.volume))) || 1 };
  }, [rows]);
  if (!computed) return <div className="empty">No valid candle history available.</div>;
  const { min, max, width, points, volume } = computed;
  const y = (value: Amount) => 226 - (Number(value) - min) * 198 / (max - min);
  const active = rows[hover ?? rows.length - 1];
  return <div className="candle-wrap"><div className="ohlc-line"><span>{new Date(active.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', timeZone: 'UTC' })} UTC</span>{(['open', 'high', 'low', 'close'] as const).map(k => <span key={k}><b>{k[0].toUpperCase()}</b> {Number(active[k]).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>)}</div>
    <svg viewBox="0 0 980 320" className="candles" tabIndex={0} role="img" aria-label="Hourly candlestick and base-volume chart. Arrow keys inspect candles." onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setHover(v => Math.max(0, Math.min(rows.length - 1, (v ?? rows.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)))); } }} onMouseMove={e => { const rect = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - rect.left) / rect.width * 980; setHover(Math.max(0, Math.min(rows.length - 1, Math.floor((x - 42) / width)))); }} onMouseLeave={() => setHover(null)}>
    {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="42" x2="910" y1={28 + i * 49.5} y2={28 + i * 49.5} stroke="var(--border)" strokeDasharray="3 5"/><text x="922" y={32 + i * 49.5} fill="var(--muted)" fontSize="10">{(max - i * (max - min) / 4).toLocaleString('en-US', { maximumFractionDigits: 1 })}</text></g>)}
    {rows.map((c, i) => { const x = 42 + (i + 0.5) * width, up = Number(c.close) >= Number(c.open), color = up ? 'var(--positive)' : 'var(--negative)'; return <g key={c.timestamp}><line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1"/><rect x={x - width * 0.28} y={Math.min(y(c.open), y(c.close))} width={Math.max(1, width * 0.56)} height={Math.max(1.2, Math.abs(y(c.open) - y(c.close)))} fill={color}/><rect x={x - width * 0.28} y={285 - Number(c.volume) / volume * 35} width={Math.max(1, width * 0.56)} height={Number(c.volume) / volume * 35} fill={color} opacity="0.27"/></g>; })}
    <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.4" opacity="0.9"/>
    {hover !== null && <line x1={42 + (hover + 0.5) * width} x2={42 + (hover + 0.5) * width} y1="24" y2="286" stroke="var(--muted)" strokeDasharray="3 3"/>}
    {[0, 1, 2, 3].map(i => <text key={i} x={42 + i * 860 / 3} y="311" fill="var(--muted)" fontSize="10" textAnchor={i === 3 ? 'end' : 'start'}>{new Date(rows[Math.min(rows.length - 1, Math.floor(i * (rows.length - 1) / 3))].timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>)}
    </svg><div className="chart-legend"><span className="legend-line"/>EMA 12 <span className="volume-key"/>Base asset volume <span className="muted right">Closed 1h candles · hover or use arrow keys</span></div>
  </div>;
}
