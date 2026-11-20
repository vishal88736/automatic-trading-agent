import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUpRight,
  Bot,
  ChartNoAxesColumn,
  FlaskConical,
  LayoutDashboard,
  Library,
  Newspaper,
  Pause,
  Play,
  ShieldCheck,
  Wallet,
  WandSparkles,
} from "lucide-react";
import { KronoMark } from "../brand";
import { Coin } from "../ui";
import type { createLandingScene } from "./LandingScene";
import { marketAssets, marketNames } from "./market-assets";
import {
  landingSectionHref,
  signInHref,
  workspaceHref,
  type LandingSection,
} from "./navigation";

const workflow = [
  {
    module: "builder",
    title: "Build your rules",
    description:
      "Start in plain English, a visual builder, or the structured editor.",
    Icon: WandSparkles,
  },
  {
    module: "backtests",
    title: "Backtest a strategy",
    description:
      "Replay historical candles and review returns, drawdown, and simulated fills.",
    Icon: ChartNoAxesColumn,
  },
  {
    module: "agents",
    title: "Run an agent",
    description:
      "Set risk limits and let a backend worker paper trade while you’re away.",
    Icon: Bot,
  },
] as const;

const tools = [
  {
    module: "strategies",
    title: "Strategy library",
    description: "Customize prebuilt strategies and compare saved versions.",
    Icon: Library,
  },
  {
    module: "paper",
    title: "Paper trading",
    description:
      "Place simulated orders and review fills, fees, and available funds.",
    Icon: FlaskConical,
  },
  {
    module: "portfolio",
    title: "Portfolio",
    description:
      "Track holdings, equity, and profit or loss across your virtual account.",
    Icon: Wallet,
  },
  {
    module: "markets",
    title: "Market analysis",
    description: "Explore crypto prices, charts, indicators, and AI insights.",
    Icon: Activity,
  },
  {
    module: "news",
    title: "Crypto news",
    description:
      "Follow recent headlines with publication dates and original sources.",
    Icon: Newspaper,
  },
  {
    module: "dashboard",
    title: "Dashboard",
    description:
      "Check your virtual portfolio, agent activity, and market watch in one place.",
    Icon: LayoutDashboard,
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

function LandingArt() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<ReturnType<typeof createLandingScene>>(null);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    function update() {
      setReduced(preference.matches);
      if (preference.matches) scene.current?.setPaused(true);
    }
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    let active = true;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    observer.observe(surface);
    void import("./LandingScene")
      .then(({ createLandingScene: mount }) => {
        if (active) scene.current = mount(surface, setReady);
      })
      .catch(() => {
        if (active) setReady(false);
      });
    return () => {
      active = false;
      observer.disconnect();
      scene.current?.destroy();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    if (ready) scene.current?.setPaused(paused || reduced || !visible);
  }, [paused, ready, reduced, visible]);

  return (
    <div className="landing-art">
      <div className="landing-scene" aria-hidden="true">
        <canvas ref={canvas} data-ready={ready} />
      </div>
      {ready && !reduced && (
        <button
          className="landing-motion"
          type="button"
          aria-label={
            paused ? "Play landing animation" : "Pause landing animation"
          }
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? (
            <Play size={16} aria-hidden />
          ) : (
            <Pause size={16} aria-hidden />
          )}
        </button>
      )}
    </div>
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
            <p className="landing-mode">
              <ShieldCheck size={17} aria-hidden /> Paper trading workspace
            </p>
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
          </div>
          <LandingArt />
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

      <section
        className="landing-wrap landing-workflow"
        id="landing-workflow"
        aria-labelledby="landing-workflow-title"
        tabIndex={-1}
      >
        <div className="landing-research-art">
          <img
            src="/art/krono-sapphire-research.webp"
            alt=""
            width={1200}
            height={800}
            loading="lazy"
          />
        </div>
        <div>
          <h2 id="landing-workflow-title">From strategy to paper trading</h2>
          <ol className="landing-workflow-list">
            {workflow.map(({ module, title, description, Icon }) => (
              <li key={module}>
                <a href={workspaceHref(module)}>
                  <Icon size={21} aria-hidden />
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  <ArrowUpRight size={16} aria-hidden />
                </a>
              </li>
            ))}
          </ol>
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
          <ul className="landing-tool-grid">
            {tools.map(({ module, title, description, Icon }) => (
              <li key={module}>
                <a
                  href={
                    module === "dashboard" ? signInHref : workspaceHref(module)
                  }
                >
                  <div className="landing-tool-icons">
                    <span className="landing-tool-icon">
                      <Icon size={24} aria-hidden />
                    </span>
                    <ArrowUpRight size={18} aria-hidden />
                  </div>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </a>
              </li>
            ))}
          </ul>
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
          <nav aria-label="Krono links">
            <LandingSectionLink section="workflow">
              How it works
            </LandingSectionLink>
            <LandingSectionLink section="tools">
              Workspace tools
            </LandingSectionLink>
            <a href={workspaceHref("settings")}>Account settings</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
