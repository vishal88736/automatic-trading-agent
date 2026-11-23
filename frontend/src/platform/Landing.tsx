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
import emblem from "../assets/krono-emblem.webp";
import { KronoBrand } from "../brand";
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
            <KronoBrand />
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
          <img
            className="kx-hero-emblem"
            src={emblem}
            alt="Krono emblem with a lime orbit around a metallic clock face"
            width={1024}
            height={1024}
            fetchPriority="high"
          />
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
        <div className="kx-brand">
          <KronoBrand />
        </div>
        <small>
          Crypto trading carries risk. Paper results do not guarantee live
          performance.
        </small>
      </footer>
    </div>
  );
}
