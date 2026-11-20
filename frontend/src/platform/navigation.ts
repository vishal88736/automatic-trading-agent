export const modules = [
  ["dashboard", "Dashboard"],
  ["agents", "AI Trading Agents"],
  ["strategies", "Strategies"],
  ["builder", "Custom Strategy Builder"],
  ["backtests", "Backtesting Lab"],
  ["paper", "Paper Trading"],
  ["markets", "Market Analysis and AI Insights"],
  ["portfolio", "Portfolio"],
  ["news", "Crypto News"],
  ["settings", "Settings"],
] as const;

export type Module = (typeof modules)[number][0];

export const legacyFixture =
  import.meta.env.DEV &&
  import.meta.env.VITE_KRONO_LEGACY_FIXTURES === "true" &&
  window.location.pathname !== "/workspace";

const historicalRoutes: Record<string, Module> = {
  platform: "agents",
  "platform/paper-agents": "agents",
  "platform/strategies": "strategies",
  "platform/backtests": "backtests",
  "platform/paper": "paper",
  "platform/markets": "markets",
  "platform/news": "news",
  overview: "dashboard",
  positions: "portfolio",
  wallet: "portfolio",
  desk: "paper",
  executions: "paper",
  observatory: "agents",
  sessions: "agents",
  risk: "settings",
};

const fixtureRoutes: Partial<Record<Module, string>> = {
  agents: "platform/paper-agents",
  strategies: "platform/strategies",
  backtests: "platform/backtests",
  paper: "platform/paper",
};

export function workspaceHref(page: Module, suffix = "") {
  return `#/${(legacyFixture && fixtureRoutes[page]) || page}${suffix}`;
}

export function readRoute() {
  const [path = "", query] = location.hash.replace(/^#\/?/, "").split("?", 2);
  const isRetiredDex = path === "aegis" || path.startsWith("aegis/");
  const candidate = isRetiredDex ? (path.split("/")[1] ?? "") : path;
  const report = /^(?:platform\/)?backtests\/([a-f0-9-]{36})$/i.exec(candidate);
  const page =
    (report ? "backtests" : modules.find(([key]) => key === candidate)?.[0]) ??
    (Object.hasOwn(historicalRoutes, candidate)
      ? historicalRoutes[candidate]
      : "dashboard");
  const suffix = (report ? `/${report[1]}` : "") + (query ? `?${query}` : "");
  return { page, reportId: report?.[1], href: workspaceHref(page, suffix) };
}
