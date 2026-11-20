import { useEffect, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  ChartNoAxesColumn,
  LayoutDashboard,
  Library,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { KronoMark } from "../brand";
import { Coin } from "../ui";
import { marketAssets, marketNames } from "./market-assets";
import {
  landingSectionHref,
  signInHref,
  workspaceHref,
  type LandingSection,
} from "./navigation";

const workflow = [
  {
    section: "workflow",
    title: "From strategy to paper trading",
    description: [
      "Describe an idea in plain English, build it with visual rules, or edit the structured strategy directly.",
      "Replay the strategy on historical candles and review equity, drawdown, and simulated fills before you run it.",
    ],
    art: "krono-sapphire-research.webp",
    primary: [workspaceHref("backtests"), "Backtest a strategy"],
    secondary: [workspaceHref("builder"), "Build your rules"],
  },
  {
    section: "agents",
    title: "Run an agent while you’re away",
    description: [
      "Assign a strategy and virtual capital. Krono’s backend worker can keep monitoring the market and placing simulated orders after you close the browser.",
      "Check decisions and order history when you return. Pause, resume, or stop the agent from your workspace.",
    ],
    art: "krono-sapphire-agents.webp",
    primary: [workspaceHref("agents"), "Explore AI agents"],
    secondary: [signInHref, "Open dashboard"],
  },
] as const;

const controls = [
  {
    href: workspaceHref("strategies"),
    title: "Track strategy versions",
    description: "Customize prebuilt rules and compare your saved versions.",
    Icon: Library,
  },
  {
    href: workspaceHref("agents"),
    title: "Set trading limits",
    description:
      "Choose an agent’s virtual capital allocation, exposure limits, and maximum daily loss.",
    Icon: SlidersHorizontal,
  },
  {
    href: signInHref,
    title: "Monitor your workspace",
    description:
      "See agent activity, portfolio equity, and market watch on the dashboard.",
    Icon: LayoutDashboard,
  },
  {
    href: workspaceHref("settings"),
    title: "Manage your paper account",
    description:
      "Stop new simulated orders or reset virtual funds in Settings.",
    Icon: ShieldCheck,
  },
] as const;

const tools = [
  {
    title: "Markets and news",
    description:
      "Explore crypto prices, indicators, and AI insights. Follow recent coverage with publication dates and original sources.",
    art: "krono-sapphire-markets.webp",
    artHeight: 676,
    primary: ["markets", "Explore markets"],
    secondary: ["news", "Read crypto news"],
  },
  {
    title: "Paper orders and portfolio",
    description:
      "Place orders with virtual USDT and review fills, holdings, fees, and profit or loss.",
    art: "krono-sapphire-portfolio.webp",
    artHeight: 614,
    primary: ["paper", "Paper trading"],
    secondary: ["portfolio", "View portfolio"],
  },
] as const;

function revealSection(section: LandingSection) {
  const target = document.getElementById(`landing-${section}`);
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "start" });
}

export function LandingSectionLink({
  section,
  children,
  className,
}: {
  section: LandingSection;
  children: ReactNode;
  className?: string;
}) {
  const href = landingSectionHref(section);
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (
          location.hash === href &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          revealSection(section);
        }
      }}
    >
      {children}
    </a>
  );
}

export function Landing({ section }: { section?: LandingSection }) {
  useEffect(() => {
    if (section) revealSection(section);
    else window.scrollTo(0, 0);
  }, [section]);

  return (
    <div className="krono-landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-wrap landing-hero-grid">
          <div className="landing-copy">
            <h1 id="landing-title">
              Build and test <span>crypto strategies.</span>
            </h1>
            <p className="landing-lead">
              Backtest your ideas on historical market data, then run autonomous
              agents with virtual funds.
            </p>
            <div className="landing-actions">
              <a className="button primary landing-cta" href={signInHref}>
                Get started <ArrowUpRight size={18} aria-hidden />
              </a>
              <LandingSectionLink
                section="workflow"
                className="landing-text-button"
              >
                See how it works <ArrowDown size={16} aria-hidden />
              </LandingSectionLink>
            </div>
            <nav
              className="landing-hero-tools"
              aria-label="Featured workspace tools"
            >
              <a href={workspaceHref("backtests")}>
                <ChartNoAxesColumn size={20} aria-hidden />
                <span>
                  <strong>Backtesting Lab</strong>
                  <small>Historical replay</small>
                </span>
                <ArrowUpRight size={14} aria-hidden />
              </a>
              <a href={workspaceHref("agents")}>
                <Bot size={20} aria-hidden />
                <span>
                  <strong>AI Trading Agents</strong>
                  <small>Paper execution</small>
                </span>
                <ArrowUpRight size={14} aria-hidden />
              </a>
            </nav>
          </div>
          <div className="landing-art">
            <img
              src="/art/krono-sapphire-terminal.webp"
              alt=""
              width={1440}
              height={810}
              fetchPriority="high"
            />
          </div>
        </div>
      </section>

      <section className="landing-market-strip" aria-label="Supported markets">
        <div className="landing-wrap landing-market-inner">
          <p>Supported markets</p>
          <ul>
            {marketAssets.map((asset) => (
              <li key={asset}>
                <a
                  href={workspaceHref("markets", `?asset=${asset}`)}
                  aria-label={`${marketNames[asset]} (${asset})`}
                >
                  <span aria-hidden="true">
                    <Coin symbol={asset} />
                  </span>
                  <span className="landing-market-name">
                    <span>{marketNames[asset]}</span> <small>{asset}</small>
                  </span>
                  <ArrowUpRight size={14} aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {workflow.map(
        ({ section, title, description, art, primary, secondary }) => (
          <section
            key={section}
            className="landing-feature"
            id={`landing-${section}`}
            aria-labelledby={`landing-${section}-title`}
            tabIndex={-1}
          >
            <div className="landing-wrap landing-feature-inner">
              <div className="landing-feature-copy">
                <h2 id={`landing-${section}-title`}>{title}</h2>
                {description.map((line) => (
                  <p key={line}>{line}</p>
                ))}
                <div className="landing-actions">
                  <a className="button primary landing-cta" href={primary[0]}>
                    {primary[1]} <ArrowUpRight size={18} aria-hidden />
                  </a>
                  <a className="landing-text-button" href={secondary[0]}>
                    {secondary[1]} <ArrowUpRight size={16} aria-hidden />
                  </a>
                </div>
              </div>
              <div className="landing-feature-art">
                <img
                  src={`/art/${art}`}
                  alt=""
                  width={1200}
                  height={800}
                  loading="lazy"
                />
              </div>
            </div>
          </section>
        ),
      )}

      <section
        className="landing-controls"
        aria-labelledby="landing-controls-title"
      >
        <div className="landing-wrap">
          <div className="landing-controls-intro">
            <h2 id="landing-controls-title">Control how your strategy runs</h2>
            <p>
              Set the rules, check what your agents did, and manage your virtual
              account in one workspace.
            </p>
          </div>
          <ul className="landing-control-grid">
            {controls.map(({ href, title, description, Icon }) => (
              <li key={title}>
                <a href={href}>
                  <span className="landing-control-icons">
                    <span>
                      <Icon size={23} aria-hidden />
                    </span>
                    <ArrowUpRight size={17} aria-hidden />
                  </span>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        className="landing-tools"
        id="landing-tools"
        aria-labelledby="landing-tools-title"
        tabIndex={-1}
      >
        <div className="landing-wrap landing-tools-inner">
          <h2 id="landing-tools-title">Explore the workspace</h2>
          <div className="landing-tool-grid">
            {tools.map(
              ({ title, description, art, artHeight, primary, secondary }) => (
                <article key={title} className="landing-tool-card">
                  <div className="landing-tool-art">
                    <img
                      src={`/art/${art}`}
                      alt=""
                      width={1200}
                      height={artHeight}
                      loading="lazy"
                    />
                  </div>
                  <div className="landing-tool-copy">
                    <h3>{title}</h3>
                    <p>{description}</p>
                    <div className="landing-actions">
                      <a
                        className="button primary landing-cta"
                        href={workspaceHref(primary[0])}
                      >
                        {primary[1]} <ArrowUpRight size={17} aria-hidden />
                      </a>
                      <a
                        className="landing-text-button"
                        href={workspaceHref(secondary[0])}
                      >
                        {secondary[1]} <ArrowUpRight size={16} aria-hidden />
                      </a>
                    </div>
                  </div>
                </article>
              ),
            )}
          </div>
        </div>
      </section>

      <section
        className="landing-wrap landing-invitation"
        aria-labelledby="landing-invitation-title"
      >
        <div>
          <h2 id="landing-invitation-title">Ready to test a strategy?</h2>
          <p>Open your Krono account and start with virtual funds.</p>
        </div>
        <a href={signInHref} className="button primary landing-cta">
          Open Krono <ArrowUpRight size={18} aria-hidden />
        </a>
      </section>

      <footer className="landing-footer">
        <div className="landing-wrap">
          <a
            href={workspaceHref("dashboard")}
            className="landing-footer-brand"
            aria-label="Back to Krono home"
            onClick={() => {
              if (location.hash === workspaceHref("dashboard"))
                window.scrollTo(0, 0);
            }}
          >
            <KronoMark /> Krono.
          </a>
          <div className="landing-footer-links">
            <nav aria-label="Krono links">
              <h3>Explore</h3>
              <LandingSectionLink section="workflow">
                How it works
              </LandingSectionLink>
              <LandingSectionLink section="agents">
                AI agents
              </LandingSectionLink>
              <LandingSectionLink section="tools">
                Workspace tools
              </LandingSectionLink>
            </nav>
            <nav aria-label="Research tools">
              <h3>Research</h3>
              <a href={workspaceHref("strategies")}>Strategies</a>
              <a href={workspaceHref("backtests")}>Backtesting Lab</a>
              <a href={workspaceHref("markets")}>Market analysis</a>
            </nav>
            <nav aria-label="Account links">
              <h3>Account</h3>
              <a href={signInHref}>Sign in</a>
              <a href={workspaceHref("portfolio")}>Portfolio</a>
              <a href={workspaceHref("settings")}>Account settings</a>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
