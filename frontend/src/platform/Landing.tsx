import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  ChartNoAxesColumn,
  FlaskConical,
  MessageSquareText,
  Menu,
  Plug,
  ShieldCheck,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import { KronoMark } from "../brand";
import { ThemeToggle } from "../ThemeToggle";
import {
  landingSectionHref,
  landingSections,
  signInHref,
  signUpHref,
  type LandingSection,
} from "./navigation";
import { MarketTicker } from "./MarketTicker";

const features = [
  {
    icon: MessageSquareText,
    title: "Build strategies by chatting",
    text: "“Buy ETH when RSI drops below 30, 5% per trade, 3% stop.” The AI turns it into precise, editable rules.",
  },
  {
    icon: ChartNoAxesColumn,
    title: "Backtest on real candles",
    text: "Every agent is replayed on recent hourly market data with fees, slippage and a holdout window before it trades.",
  },
  {
    icon: Bot,
    title: "Agents that never sleep",
    text: "Agents run on the server, not in your browser. Close the tab and they keep evaluating every new candle.",
  },
  {
    icon: Trophy,
    title: "Public leaderboard",
    text: "See how every running agent performs, ranked by return on its allocation and drawdown.",
  },
  {
    icon: FlaskConical,
    title: "Paper trade risk-free",
    text: "Start with 10,000 virtual USDT priced against the live market. Reset any time.",
  },
  {
    icon: Plug,
    title: "Go live when ready",
    text: "Promote a proven agent to your own exchange account with trade-only keys and hard risk caps.",
  },
];

const steps = [
  [
    MessageSquareText,
    "Describe",
    "Tell the strategy builder what to trade and how much to risk.",
  ],
  [
    ChartNoAxesColumn,
    "Validate",
    "Backtest the rules and check the risk limits.",
  ],
  [
    Bot,
    "Deploy",
    "Start a paper agent that runs on the server around the clock.",
  ],
  [Trophy, "Compete", "Track your agent against others on the leaderboard."],
] as const;

const chart = [
  42, 44, 43, 47, 46, 49, 52, 50, 54, 53, 57, 61, 59, 63, 62, 66, 70, 68, 72,
  75,
];

function HeroPreview() {
  const max = Math.max(...chart),
    min = Math.min(...chart);
  const points = chart
    .map(
      (v, i) =>
        `${(i / (chart.length - 1)) * 100},${40 - ((v - min) / (max - min)) * 34}`,
    )
    .join(" ");
  return (
    <figure className="kx-showcase">
      <div className="kx-preview" aria-hidden>
        <div className="kx-preview-head">
          <KronoMark />
          <strong>Paper workspace</strong>
          <span className="kx-pill">
            <span className="kx-dot" /> Running
          </span>
        </div>
        <div className="kx-preview-reading">
          <small>ETH dip buyer</small>
          <strong className="kx-num">+12.84%</strong>
          <small>Paper return</small>
        </div>
        <svg
          viewBox="0 0 100 42"
          preserveAspectRatio="none"
          className="kx-preview-chart"
        >
          <defs>
            <linearGradient id="kx-hero-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--lime)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--lime)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon points={`0,42 ${points} 100,42`} fill="url(#kx-hero-fill)" />
          <polyline
            points={points}
            fill="none"
            stroke="var(--lime)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <ul className="kx-preview-feed">
          <li>
            <span className="kx-side" data-side="buy">
              BUY
            </span>{" "}
            0.42 ETH · RSI 27.9 crossed entry
          </li>
          <li>
            <span className="kx-side" data-side="hold">
              HOLD
            </span>{" "}
            Waiting for exit, RSI 54.2
          </li>
          <li>
            <span className="kx-side" data-side="sell">
              SELL
            </span>{" "}
            0.42 ETH · take profit hit
          </li>
        </ul>
      </div>
      <div className="kx-preview-board" aria-hidden>
        <span>
          <Trophy size={14} /> Paper leaderboard
        </span>
        <ol>
          <li>
            <b>1</b> BTC momentum <em className="kx-num">+18.2%</em>
          </li>
          <li>
            <b>2</b> ETH dip buyer <em className="kx-num">+12.8%</em>
          </li>
          <li>
            <b>3</b> SOL breakout <em className="kx-num">+9.4%</em>
          </li>
        </ol>
      </div>
      <figcaption className="kx-preview-caption">
        Illustrative preview
      </figcaption>
    </figure>
  );
}

export function Landing({ section }: { section?: LandingSection }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (section)
      document.getElementById(`landing-${section}`)?.scrollIntoView();
  }, [section]);

  function closeMenu() {
    if (menuOpen) menuButton.current?.focus({ preventScroll: true });
    setMenuOpen(false);
  }

  return (
    <div className="kx-landing unified-workspace">
      <header
        className="kx-landing-nav"
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) closeMenu();
        }}
      >
        <div className="kx-landing-nav-inner">
          <a
            className="kx-brand"
            href="#/"
            onClick={() => {
              setMenuOpen(false);
              window.scrollTo(0, 0);
            }}
          >
            <KronoMark />
            <span>Krono</span>
          </a>
          <nav
            id="kx-landing-links"
            aria-label="About Krono"
            data-open={menuOpen}
          >
            {landingSections.map(([id, label]) => (
              <a
                key={id}
                href={landingSectionHref(id)}
                aria-current={section === id ? "location" : undefined}
                onClick={closeMenu}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="kx-landing-actions">
            <ThemeToggle />
            <a className="button secondary" href={signInHref}>
              Sign in
            </a>
            <a className="button primary kx-hide-sm" href={signUpHref}>
              Get started
            </a>
            <button
              type="button"
              ref={menuButton}
              className="kx-icon-button kx-only-mobile"
              aria-label={
                menuOpen ? "Close site navigation" : "Open site navigation"
              }
              aria-expanded={menuOpen}
              aria-controls="kx-landing-links"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? (
                <X size={17} aria-hidden />
              ) : (
                <Menu size={17} aria-hidden />
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="kx-landing-main">
        <section className="kx-hero">
          <div className="kx-hero-copy">
            <span className="kx-badge" data-tone="accent">
              <Sparkles size={14} aria-hidden /> AI-built crypto trading agents
            </span>
            <h1>
              Your strategy.
              <br />
              <em>Trading 24/7.</em>
            </h1>
            <p>
              Describe a trading idea in plain English. Krono builds the rules,
              backtests them on real market data, and runs your agent around the
              clock, on paper first, then on your own exchange account.
            </p>
            <div className="kx-actions">
              <a className="button primary kx-lg" href={signUpHref}>
                Start paper trading free <ArrowRight size={16} />
              </a>
              <a
                className="button secondary kx-lg"
                href={landingSectionHref("workflow")}
              >
                How it works
              </a>
            </div>
            <ul className="kx-hero-notes">
              <li>
                <span>
                  <FlaskConical size={15} aria-hidden />
                </span>{" "}
                10,000 virtual USDT
              </li>
              <li>
                <span>
                  <Bot size={15} aria-hidden />
                </span>{" "}
                Server-run agents
              </li>
              <li>
                <span>
                  <ShieldCheck size={15} aria-hidden />
                </span>{" "}
                Built-in risk limits
              </li>
            </ul>
          </div>
          <HeroPreview />
        </section>

        <section
          className="kx-landing-section kx-workflow"
          id="landing-workflow"
        >
          <h2>From idea to running agent in minutes</h2>
          <ol className="kx-timeline">
            {steps.map(([Icon, title, text]) => (
              <li key={title}>
                <span className="kx-feature-icon">
                  <Icon size={19} aria-hidden />
                </span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section
          className="kx-landing-ticker"
          aria-labelledby="kx-market-heading"
        >
          <h2 id="kx-market-heading">
            <Activity size={20} aria-hidden /> Crypto market prices
          </h2>
          <MarketTicker />
        </section>

        <section className="kx-landing-section" id="landing-agents">
          <h2>Everything you need to automate a strategy</h2>
          <div className="kx-feature-grid">
            {features.map(({ icon: Icon, title, text }) => (
              <article key={title} className="kx-card kx-feature">
                <span className="kx-feature-icon">
                  <Icon size={20} aria-hidden />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="kx-landing-section" id="landing-tools">
          <div className="kx-card kx-cta">
            <div>
              <h2>Paper trading today. Live trading when you're ready.</h2>
              <p>
                Paper accounts use live Coinbase prices with simulated fees and
                slippage. Live trading links your own exchange with trade-only
                permissions, so funds never leave your account.
              </p>
            </div>
            <a className="button primary kx-lg" href={signUpHref}>
              Create your account <ArrowRight size={16} />
            </a>
          </div>
        </section>
      </main>

      <footer className="kx-landing-footer">
        <span>
          <KronoMark /> Krono
        </span>
        <small>
          Crypto trading carries risk. Paper results do not guarantee live
          performance.
        </small>
      </footer>
    </div>
  );
}
