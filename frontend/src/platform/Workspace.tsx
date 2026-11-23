import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  ChartNoAxesColumn,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  Newspaper,
  Plug,
  Settings2,
  SlidersHorizontal,
  Trophy,
  Wallet,
  WandSparkles,
  X,
} from "lucide-react";
import { KronoBrand, KronoMark } from "../brand";
import { Landing } from "./Landing";
import { ThemeToggle } from "../ThemeToggle";
import { Auth } from "./Auth";
import { platform, PlatformRequestError } from "./client";
import {
  moduleGroups,
  modules,
  moduleSubtitles,
  readRoute,
  workspaceHref,
  type Module,
} from "./navigation";
import { DashboardMarkets } from "./DashboardPanels";
import { MarketTicker } from "./MarketTicker";
import "./platform.css";

const BacktestingLab = lazy(() => import("./BacktestingLab"));
const MarketResearch = lazy(() => import("./MarketResearch"));
const PaperAgents = lazy(() => import("./PaperAgents"));
const PaperAccount = lazy(() => import("./PaperTrading"));
const Strategies = lazy(() => import("./Strategies"));
const Leaderboard = lazy(() => import("./Leaderboard"));
const LiveTrading = lazy(() => import("./LiveTrading"));
const LiveNews = lazy(() => import("./LiveNews"));

const moduleIcons = {
  dashboard: LayoutDashboard,
  paper: FlaskConical,
  live: Plug,
  portfolio: Wallet,
  agents: Bot,
  leaderboard: Trophy,
  builder: WandSparkles,
  strategies: SlidersHorizontal,
  backtests: ChartNoAxesColumn,
  markets: Activity,
  news: Newspaper,
  settings: Settings2,
} satisfies Record<Module, typeof Activity>;

interface Session {
  userId: string;
  email: string;
  displayName?: string;
}
type Authentication =
  | { state: "loading" | "signed-out" }
  | {
      state: "signed-in";
      session: Session;
      available: boolean;
      liveEnabled: boolean;
    }
  | { state: "error"; message: string };

function useWorkerStatus(enabled: boolean) {
  const [summary, setSummary] = useState<{
    worker_online: boolean;
    items: { status: string; stage: string }[];
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    async function refresh() {
      try {
        const next =
          await platform<NonNullable<typeof summary>>("/paper-agents");
        if (mounted) setSummary(next);
      } catch {
        if (mounted) setSummary(null);
      }
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 15000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [enabled]);
  return summary;
}

function DashboardAgents() {
  const summary = useWorkerStatus(true);
  const running = summary?.items.filter((a) => a.status === "RUNNING").length;
  const paused = summary?.items.filter((a) => a.status === "PAUSED").length;
  return (
    <section className="platform-product-panel dashboard-agents">
      <div className="dashboard-panel-heading">
        <h3>
          <Bot size={17} aria-hidden /> Agent activity
        </h3>
        <a href={workspaceHref("agents")} aria-label="Manage agents">
          <ArrowRight size={16} aria-hidden />
        </a>
      </div>
      {!summary && <p role="status">Checking worker status…</p>}
      {summary && (
        <>
          <p className="dashboard-worker" data-online={summary.worker_online}>
            {summary.worker_online ? "Worker online" : "Worker offline"}
          </p>
          <dl className="dashboard-agent-counts">
            <div>
              <dt>Running</dt>
              <dd>{running}</dd>
            </div>
            <div>
              <dt>Paused</dt>
              <dd>{paused}</dd>
            </div>
          </dl>
          <a className="kx-link" href={workspaceHref("leaderboard")}>
            <Trophy size={14} aria-hidden /> See the leaderboard
          </a>
        </>
      )}
    </section>
  );
}

function initials(session: Session) {
  const source = session.displayName || session.email || "?";
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

export function Workspace() {
  const [route, setRoute] = useState(readRoute);
  const [auth, setAuth] = useState<Authentication>({ state: "loading" });
  const [accountError, setAccountError] = useState("");
  const [accountReady, setAccountReady] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let previousPage = readRoute().page;
    function sync() {
      const next = readRoute();
      if (location.hash !== next.href)
        history.replaceState(null, "", next.href);
      setRoute(next);
      if (next.signIn || next.page !== previousPage) window.scrollTo(0, 0);
      previousPage = next.page;
      setMenuOpen(false);
    }
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  async function check() {
    setAuth({ state: "loading" });
    setAccountError("");
    setAccountReady(false);
    try {
      const health = await platform<{
        productConfigured: boolean;
        liveEnabled: boolean;
      }>("/health");
      const session = await platform<Session>("/auth/session");
      if (readRoute().signIn) {
        history.replaceState(null, "", workspaceHref("dashboard"));
        setRoute(readRoute());
        window.scrollTo(0, 0);
      }
      setAuth({
        state: "signed-in",
        session,
        available: health.productConfigured,
        liveEnabled: health.liveEnabled === true,
      });
      if (health.productConfigured) {
        try {
          await platform("/paper-account", "POST");
          setAccountReady(true);
        } catch (error) {
          setAccountError((error as Error).message);
        }
      }
    } catch (error) {
      if (error instanceof PlatformRequestError && error.status === 401) {
        setAuth({ state: "signed-out" });
      } else {
        setAuth({ state: "error", message: (error as Error).message });
      }
    }
  }

  useEffect(() => {
    void check();
  }, []);

  async function signOut() {
    setSigningOut(true);
    setAccountError("");
    try {
      await platform("/auth/logout", "POST", {});
      setMenuOpen(false);
      setAuth({ state: "signed-out" });
      setAccountReady(false);
    } catch (error) {
      setAccountError((error as Error).message);
    } finally {
      setSigningOut(false);
    }
  }

  const { page, reportId } = route;
  const title = modules.find(([id]) => id === page)![1];
  const session = auth.state === "signed-in" ? auth.session : null;
  const showLanding =
    auth.state === "signed-out" && page === "dashboard" && !route.signIn;
  const worker = useWorkerStatus(Boolean(session && accountReady));

  if (showLanding) return <Landing section={route.landingSection} />;

  if (auth.state !== "signed-in")
    return (
      <div className="kx-standalone unified-workspace">
        {auth.state === "signed-out" && (
          <Auth
            done={() => void check()}
            focusEmail={route.signIn}
            register={route.register}
          />
        )}
        {auth.state === "loading" && (
          <div className="kx-splash" role="status">
            <KronoMark />
            <span>Connecting to Krono…</span>
          </div>
        )}
        {auth.state === "error" && (
          <div className="kx-splash">
            <KronoMark />
            <h1>Krono is unavailable</h1>
            <p role="alert">{auth.message}</p>
            <p className="muted">
              Start the backend with <code>make dev</code>, then retry.
            </p>
            <button className="primary" onClick={() => void check()}>
              Retry connection
            </button>
          </div>
        )}
      </div>
    );

  function closeNavigation() {
    if (menuOpen) menuButton.current?.focus({ preventScroll: true });
    setMenuOpen(false);
  }
  const liveMode = page === "live";

  return (
    <div className="kx-app unified-workspace" data-page={page}>
      <aside
        id="kx-sidebar"
        className="kx-sidebar"
        data-open={menuOpen}
        aria-label="Sidebar"
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) closeNavigation();
        }}
      >
        <div className="kx-sidebar-head">
          <a
            className="kx-brand"
            href={workspaceHref("dashboard")}
            onClick={closeNavigation}
          >
            <KronoBrand />
          </a>
          <button
            className="kx-icon-button kx-only-mobile"
            aria-label="Close navigation"
            onClick={closeNavigation}
          >
            <X size={18} />
          </button>
        </div>
        <nav className="kx-nav" aria-label="Main navigation">
          {moduleGroups.map((group) => (
            <div key={group.label} className="kx-nav-group">
              <span className="kx-nav-label">{group.label}</span>
              {group.items.map((id) => {
                const Icon = moduleIcons[id];
                const label = modules.find(([key]) => key === id)![1];
                return (
                  <a
                    key={id}
                    href={workspaceHref(id)}
                    aria-current={page === id ? "page" : undefined}
                    onClick={closeNavigation}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{label}</span>
                    {id === "live" && <em className="kx-pill">Beta</em>}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="kx-sidebar-foot">
          <div
            className="kx-worker"
            data-online={worker?.worker_online ?? false}
          >
            <span className="kx-dot" aria-hidden />
            <div>
              <strong>
                {worker === null
                  ? "Checking worker"
                  : worker.worker_online
                    ? "Agents worker online"
                    : "Agents worker offline"}
              </strong>
              <small>
                {worker
                  ? `${worker.items.filter((a) => a.status === "RUNNING").length} running`
                  : "Server-side execution"}
              </small>
            </div>
          </div>
          <div className="kx-user">
            <span className="kx-avatar" aria-hidden>
              {initials(auth.session)}
            </span>
            <div>
              <strong>{auth.session.displayName ?? "Trader"}</strong>
              <small>{auth.session.email}</small>
            </div>
            <button
              className="kx-icon-button"
              aria-label="Sign out"
              title="Sign out"
              disabled={signingOut}
              onClick={() => void signOut()}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {menuOpen && (
        <div className="kx-scrim" onClick={closeNavigation} aria-hidden />
      )}
      <div className="kx-main">
        <header className="kx-topbar">
          <button
            className="kx-icon-button kx-only-mobile"
            ref={menuButton}
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            aria-controls="kx-sidebar"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={18} />
          </button>
          <a
            className="kx-topbar-home kx-only-mobile"
            href={workspaceHref("dashboard")}
            aria-label="Krono overview"
          >
            <KronoMark />
          </a>
          <MarketTicker detailed />
          <div className="kx-topbar-actions">
            <div className="kx-mode" role="group" aria-label="Trading mode">
              <a
                href={workspaceHref("paper")}
                aria-current={!liveMode ? "true" : undefined}
              >
                Paper
              </a>
              <a
                href={workspaceHref("live")}
                aria-current={liveMode ? "true" : undefined}
              >
                Live
              </a>
            </div>
            <ThemeToggle segmented />
          </div>
        </header>
        <main className="kx-content platform-workspace">
          <section className="kx-page-head" key={page}>
            <div>
              <h1>{title}</h1>
              {moduleSubtitles[page] && <p>{moduleSubtitles[page]}</p>}
            </div>
            {page === "dashboard" && (
              <div className="kx-actions">
                <a
                  className="button secondary"
                  href={workspaceHref("portfolio")}
                >
                  <Wallet size={15} aria-hidden /> View portfolio
                </a>
                <a className="button primary" href={workspaceHref("builder")}>
                  <WandSparkles size={15} aria-hidden /> Build an agent
                </a>
              </div>
            )}
            {page === "strategies" && (
              <a className="button primary" href={workspaceHref("builder")}>
                <WandSparkles size={15} /> New with AI
              </a>
            )}
            {page === "agents" && (
              <a className="button primary" href={workspaceHref("builder")}>
                <WandSparkles size={15} /> Build an agent
              </a>
            )}
          </section>
          {accountError && (
            <p className="platform-error" role="alert">
              {accountError}
            </p>
          )}
          {!auth.available ? (
            <section className="platform-product-panel">
              <h2>Trading service unavailable</h2>
              <p>The account and strategy service is not reachable.</p>
              <button onClick={() => void check()}>Retry connection</button>
            </section>
          ) : !accountReady ? (
            accountError ? (
              <button onClick={() => void check()}>Retry connection</button>
            ) : (
              <p role="status" className="kx-loading">
                Opening your paper account…
              </p>
            )
          ) : (
            <Suspense
              fallback={
                <p role="status" className="kx-loading">
                  Loading {title}…
                </p>
              }
              key={auth.session.userId}
            >
              {page === "dashboard" && (
                <PaperAccount
                  view="dashboard"
                  liveEnabled={auth.liveEnabled}
                  dashboardAgents={<DashboardAgents />}
                  dashboardMarkets={<DashboardMarkets />}
                />
              )}
              {page === "agents" && <PaperAgents key={route.href} />}
              {page === "leaderboard" && <Leaderboard />}
              {page === "live" && <LiveTrading />}
              {page === "strategies" && <Strategies key="strategies" />}
              {page === "builder" && <Strategies key="builder" builder />}
              {page === "backtests" && (
                <BacktestingLab key={reportId ?? "new"} reportId={reportId} />
              )}
              {page === "paper" && <PaperAccount key="paper" />}
              {page === "portfolio" && (
                <PaperAccount key="portfolio" view="portfolio" />
              )}
              {page === "settings" && (
                <PaperAccount key="settings" view="settings" />
              )}
              {page === "markets" && <MarketResearch key={route.href} />}
              {page === "news" && <LiveNews />}
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}
