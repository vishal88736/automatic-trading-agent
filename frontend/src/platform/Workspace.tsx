import { lazy, Suspense, useEffect, useState } from "react";
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
  Play,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Wallet,
  WandSparkles,
} from "lucide-react";
import { KronoMark } from "../brand";
import { Landing, LandingSectionLink } from "./Landing";
import { ThemeToggle } from "../ThemeToggle";
import { Auth } from "./Auth";
import { platform, PlatformRequestError } from "./client";
import {
  landingSections,
  modules,
  readRoute,
  signInHref,
  workspaceHref,
  type Module,
} from "./navigation";
import { DashboardMarkets } from "./DashboardPanels";
import "./platform.css";

const BacktestingLab = lazy(() => import("./BacktestingLab"));
const MarketResearch = lazy(() => import("./MarketResearch"));
const PaperAgents = lazy(() => import("./PaperAgents"));
const PaperAccount = lazy(() => import("./PaperTrading"));
const Strategies = lazy(() => import("./Strategies"));

const moduleIcons = {
  dashboard: LayoutDashboard,
  agents: Bot,
  strategies: SlidersHorizontal,
  builder: WandSparkles,
  backtests: ChartNoAxesColumn,
  paper: FlaskConical,
  markets: Activity,
  portfolio: Wallet,
  news: Newspaper,
  settings: Settings2,
} satisfies Record<Module, typeof Activity>;

interface Session {
  userId: string;
  email: string;
}
type Authentication =
  | { state: "loading" | "signed-out" }
  | { state: "signed-in"; session: Session; available: boolean }
  | { state: "error"; message: string };

function DashboardAgents() {
  const [summary, setSummary] = useState<{
    worker_online: boolean;
    items: { status: string; stage: string }[];
  }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const next =
          await platform<NonNullable<typeof summary>>("/paper-agents");
        if (mounted) {
          setSummary(next);
          setError(false);
        }
      } catch {
        if (mounted) {
          setSummary(undefined);
          setError(true);
        }
      }
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 10000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);
  return (
    <section className="platform-product-panel dashboard-agents">
      <h2>
        <Bot size={16} /> Agent activity
      </h2>
      {error && <p role="alert">Agent status is unavailable.</p>}
      {!summary && !error && <p role="status">Checking worker status…</p>}
      {summary && (
        <>
          <p>
            {summary.worker_online
              ? "Worker online"
              : "Worker heartbeat unavailable"}
          </p>
          <p>
            {
              summary.items.filter(
                (agent) =>
                  agent.status === "RUNNING" &&
                  agent.stage === "MONITOR" &&
                  summary.worker_online,
              ).length
            }{" "}
            agents monitoring
          </p>
        </>
      )}
      <a href={workspaceHref("agents")}>
        Manage agents <ArrowRight size={15} />
      </a>
    </section>
  );
}

export function Workspace() {
  const [route, setRoute] = useState(readRoute);
  const [auth, setAuth] = useState<Authentication>({ state: "loading" });
  const [accountError, setAccountError] = useState("");
  const [accountReady, setAccountReady] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [replaying, setReplaying] = useState(false);

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
      setReplaying(false);
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
      const health = await platform<{ productConfigured: boolean }>("/health");
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

  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    function update() {
      if (motion.matches) setReplaying(false);
    }
    motion.addEventListener("change", update);
    return () => motion.removeEventListener("change", update);
  }, []);

  async function signOut() {
    setSigningOut(true);
    setAccountError("");
    try {
      await platform("/auth/logout", "POST", {});
      setAuth({ state: "signed-out" });
      setAccountReady(false);
      setReplaying(false);
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
  return (
    <div
      className="app-shell rail-shell unified-workspace"
      data-page={page}
      data-landing={showLanding || undefined}
    >
      <div className="workspace">
        <header className="topbar">
          {session && (
            <button
              className="unified-nav-toggle"
              aria-label="Toggle navigation"
              aria-expanded={menuOpen}
              aria-controls="unified-nav"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Menu size={17} />
            </button>
          )}
          <a
            className="mobile-brand"
            href={workspaceHref("dashboard")}
            aria-label="Krono home"
          >
            <KronoMark />
            <span>Krono.</span>
          </a>
          {showLanding && (
            <nav className="landing-nav" aria-label="About Krono">
              {landingSections.map(([id, label]) => (
                <LandingSectionLink key={id} section={id}>
                  {label}
                </LandingSectionLink>
              ))}
            </nav>
          )}
          <div className="header-controls">
            {!showLanding && (
              <span className="mode-label">
                <ShieldCheck size={14} /> Paper trading
              </span>
            )}
            <ThemeToggle />
            {showLanding && (
              <a className="button secondary landing-sign-in" href={signInHref}>
                Sign in <ArrowRight size={15} aria-hidden />
              </a>
            )}
            {session && (
              <button
                className="button secondary sign-out"
                aria-label="Sign out"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                <LogOut size={15} /> <span>Sign out</span>
              </button>
            )}
          </div>
        </header>
        {session && (
          <nav
            id="unified-nav"
            className="unified-nav"
            aria-label="Main navigation"
            data-expanded={menuOpen}
          >
            {modules.map(([id, label]) => {
              const Icon = moduleIcons[id];
              return (
                <a
                  key={id}
                  href={workspaceHref(id)}
                  aria-current={page === id ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </a>
              );
            })}
          </nav>
        )}
        <main className="platform-workspace">
          {showLanding && <Landing section={route.landingSection} />}
          {auth.state === "signed-out" && !showLanding && (
            <section className="product-auth-page">
              <h1 className="visually-hidden">Sign in to Krono</h1>
              <Auth done={() => void check()} focusEmail={route.signIn} />
            </section>
          )}
          {auth.state === "loading" && (
            <p className="platform-loading" role="status">
              Connecting to Krono…
            </p>
          )}
          {auth.state === "error" && (
            <section className="workspace-intro">
              <h1>Krono is unavailable</h1>
              <p role="alert">{auth.message}</p>
              <button onClick={() => void check()}>Retry connection</button>
            </section>
          )}
          {auth.state === "signed-in" && (
            <>
              <section className="workspace-intro product-intro" key={page}>
                <div className="page-heading">
                  <div>
                    <h1>{title}</h1>
                    {page === "dashboard" && (
                      <p>Your strategies, agents, and virtual portfolio.</p>
                    )}
                    {page === "settings" && <p>{session?.email}</p>}
                  </div>
                  {page === "dashboard" && accountReady && (
                    <button
                      className="dashboard-replay"
                      type="button"
                      onClick={() => setReplaying(!replaying)}
                    >
                      {replaying ? <Square size={14} /> : <Play size={14} />}
                      {replaying ? "Stop motion" : "Replay motion"}
                    </button>
                  )}
                  {page === "strategies" && (
                    <a
                      className="button primary"
                      href={workspaceHref("builder")}
                    >
                      Open strategy builder <ArrowRight size={15} />
                    </a>
                  )}
                </div>
              </section>
              {accountError && (
                <p className="platform-error" role="alert">
                  {accountError}
                </p>
              )}
              {!auth.available ? (
                <section className="platform-product-panel">
                  <h2>Paper trading service unavailable</h2>
                  <p>
                    The account and strategy service is currently unavailable.
                  </p>
                  <button onClick={() => void check()}>Retry connection</button>
                </section>
              ) : !accountReady ? (
                accountError ? (
                  <button onClick={() => void check()}>Retry connection</button>
                ) : (
                  <p role="status">Opening your virtual account…</p>
                )
              ) : (
                <Suspense
                  fallback={<p role="status">Loading {title}…</p>}
                  key={session?.userId}
                >
                  {page === "dashboard" && (
                    <div className="dashboard-viewport">
                      <div
                        className="dashboard-scene"
                        data-replay={replaying}
                        onAnimationEnd={(event) => {
                          if (
                            event.target === event.currentTarget &&
                            event.animationName.startsWith("dashboard-camera")
                          ) {
                            setReplaying(false);
                          }
                        }}
                      >
                        <PaperAccount
                          view="dashboard"
                          dashboardSide={<DashboardAgents />}
                          dashboardBottom={<DashboardMarkets />}
                        />
                      </div>
                    </div>
                  )}
                  {page === "agents" && <PaperAgents key={route.href} />}
                  {page === "strategies" && <Strategies key="strategies" />}
                  {page === "builder" && <Strategies key="builder" builder />}
                  {page === "backtests" && (
                    <BacktestingLab
                      key={reportId ?? "new"}
                      reportId={reportId}
                    />
                  )}
                  {page === "paper" && <PaperAccount key="paper" />}
                  {page === "portfolio" && (
                    <PaperAccount key="portfolio" view="portfolio" />
                  )}
                  {page === "settings" && (
                    <PaperAccount key="settings" view="settings" />
                  )}
                  {(page === "markets" || page === "news") && (
                    <MarketResearch news={page === "news"} key={route.href} />
                  )}
                </Suspense>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
