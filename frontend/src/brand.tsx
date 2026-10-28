export function KronoMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      className={`krono-mark ${className}`}
      aria-hidden="true"
    >
      <rect x="1" y="1" width="46" height="46" rx="14" fill="currentColor" />
      <path
        d="M14 12v24m17-21L22 24l11 11M14 24h8"
        stroke="#151210"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="35" cy="11" r="2.5" fill="#151210" />
    </svg>
  );
}

export function KronoBrand() {
  return (
    <>
      <KronoMark />
      <span className="brand-wordmark">
        Krono<span className="brand-period">.</span>
        <small>TRADING WORKSPACE</small>
      </span>
    </>
  );
}
