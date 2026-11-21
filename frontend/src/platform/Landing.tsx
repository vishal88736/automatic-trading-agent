import { useEffect } from "react";
import {
  ArrowRight,
  Bot,
  ChartNoAxesColumn,
  FlaskConical,
  MessageSquareText,
  Plug,
  ShieldCheck,
  Sparkles,
  Trophy,
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
  ["Describe", "Tell the strategy builder what to trade and how much to risk."],
  ["Validate", "Krono backtests the exact rules and checks the risk limits."],
  ["Deploy", "Start a paper agent. It trades 24/7 on the server."],
  ["Compete", "Climb the leaderboard, then promote your best agent to live."],
];

const chart = [
  42, 44, 43, 47, 46, 49, 52, 50, 54, 53, 57, 61, 59, 63, 62, 66, 70, 68, 72, 75,
];

function HeroPreview() {
  const max = Math.max(...chart),
    min = Math.min(...chart);
  const points = chart
    .map((v, i) => `${(i / (chart.length - 1)) * 100},${40 - ((v - min) / (max - min)) * 34}`)
    .join(" ");
  return (
    <div className="kx-preview" aria-hidden>
      <div className="kx-preview-head">
        <span className="kx-dot" />
        <strong>ETH dip buyer</strong>
        <span className="kx-pill">Running</span>
        <span className="kx-num kx-change" data-direction="up">
          +12.84%
        </span>
      </div>
      <svg viewBox="0 0 100 42" preserveAspectRatio="none" className="kx-preview-chart">
        <defs>
          <linearGradient id="kx-hero-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,42 ${points} 100,42`} fill="url(#kx-hero-fill)" />
        <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
      </svg>
      <ul className="kx-preview-feed">
        <li>
          <span className="kx-side" data-side="buy">BUY</span> 0.42 ETH · RSI 27.9 crossed entry
        </li>
        <li>
          <span className="kx-side" data-side="hold">HOLD</span> Waiting for exit, RSI 54.2
        </li>
        <li>
          <span className="kx-side" data-side="sell">SELL</span> 0.42 ETH · take profit hit
        </li>
      </ul>
      <div className="kx-preview-board">
        <span>Leaderboard</span>
        <ol>
          <li><b>1</b> Momentum Mike <em data-direction="up">+18.2%</em></li>
          <li><b>2</b> ETH dip buyer <em data-direction="up">+12.8%</em></li>
          <li><b>3</b> SOL breakout <em data-direction="up">+9.4%</em></li>
        </ol>
      </div>
    </div>
  );
}

export function Landing({ section }: { section?: LandingSection }) {
  useEffect(() => {
    if (section)
      document.getElementById(`landing-${section}`)?.scrollIntoView({ behavior: "smooth" });
  }, [section]);

  return (
    <div className="kx-landing unified-workspace">
      <header className="kx-landing-nav">
        <a className="kx-brand" href="#/">
          <KronoMark />
          <span>Krono</span>
        </a>
        <nav aria-label="About Krono">
          {landingSections.map(([id, label]) => (
            <a key={id} href={landingSectionHref(id)}>
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
        </div>
      </header>

      <section className="kx-hero">
        <div className="kx-hero-copy">
          <span className="kx-badge" data-tone="accent">
            <Sparkles size={14} aria-hidden /> AI-built crypto trading agents
          </span>
          <h1>
            Your strategy.
            <br />
            <span className="kx-gradient-text">Trading 24/7.</span>
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
            <a className="button secondary kx-lg" href={landingSectionHref("workflow")}>
              How it works
            </a>
          </div>
          <p className="kx-hero-note">
            <ShieldCheck size={15} aria-hidden /> 10,000 virtual USDT. No card
            or exchange account needed.
          </p>
        </div>
        <HeroPreview />
      </section>

      <div className="kx-landing-ticker">
        <MarketTicker />
      </div>

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

      <section className="kx-landing-section" id="landing-workflow">
        <h2>From idea to running agent in minutes</h2>
        <ol className="kx-timeline">
          {steps.map(([title, text], index) => (
            <li key={title}>
              <span className="kx-step-index">{index + 1}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
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
