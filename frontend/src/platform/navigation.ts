export const modules = [
  ["dashboard", "Overview"],
  ["paper", "Paper Trading"],
  ["live", "Live Trading"],
  ["agents", "My Agents"],
  ["builder", "AI Strategy Builder"],
  ["strategies", "Strategies"],
  ["saved-strategies", "My Strategies"],
  ["backtests", "Backtesting"],
  ["markets", "Markets & AI Insights"],
  ["news", "Crypto News"],
  ["settings", "Settings"],
] as const;

export type Module = (typeof modules)[number][0];

export const moduleGroups: { label: string; items: Module[] }[] = [
  { label: "Trade", items: ["dashboard", "paper", "live"] },
  {
    label: "Agents",
    items: ["agents", "builder", "strategies", "backtests"],
  },
  { label: "Research", items: ["markets", "news"] },
  { label: "Account", items: ["settings"] },
];

export const moduleSubtitles: Partial<Record<Module, string>> = {
  dashboard: "Paper performance and linked exchange balances.",
  paper: "Place simulated orders against live market prices.",
  live: "Link Binance, Bybit or OKX, trade by hand or let a proven agent trade for you. Start on a free testnet.",
  agents: "Autonomous agents keep running on the server after you close Krono.",
  builder: "Describe a strategy in plain English. Krono turns it into rules.",
  strategies: "Copy strategies ranked by their recorded paper returns.",
  backtests:
    "Replay a strategy version on historical candles before risking funds.",
  markets: "Live prices, indicators and an AI read of current conditions.",
  news: "Live headlines from 300+ sources, streamed as they are published.",
};

export const landingSections = [
  ["workflow", "How it works"],
  ["agents", "AI agents"],
  ["tools", "Platform"],
] as const;

export type LandingSection = (typeof landingSections)[number][0];

const historicalRoutes: Record<string, Module> = {
  platform: "agents",
  leaderboard: "strategies",
  "platform/paper-agents": "agents",
  "platform/strategies": "strategies",
  "platform/backtests": "backtests",
  "platform/paper": "paper",
  "platform/markets": "markets",
  "platform/news": "news",
  overview: "dashboard",
  portfolio: "dashboard",
  positions: "dashboard",
  wallet: "dashboard",
  desk: "paper",
  executions: "paper",
  observatory: "agents",
  sessions: "agents",
  risk: "settings",
};

export function workspaceHref(page: Module, suffix = "") {
  return `#/${page}${suffix}`;
}

export const signInHref = "#/sign-in";
export const signUpHref = "#/sign-in?mode=register";

export function landingSectionHref(section: LandingSection) {
  return workspaceHref("dashboard", `?section=${section}`);
}

export function readRoute() {
  const [path = "", query] = location.hash.replace(/^#\/?/, "").split("?", 2);
  const signIn = path === "sign-in";
  const report = /^(?:platform\/)?backtests\/([a-f0-9-]{36})$/i.exec(path);
  const page =
    (report ? "backtests" : modules.find(([key]) => key === path)?.[0]) ??
    (Object.hasOwn(historicalRoutes, path)
      ? historicalRoutes[path]
      : "dashboard");
  const suffix = (report ? `/${report[1]}` : "") + (query ? `?${query}` : "");
  const params = new URLSearchParams(query);
  const section = params.get("section");
  return {
    page,
    reportId: report?.[1],
    liveOverview: page === "dashboard" && params.get("mode") === "live",
    strategyId:
      page === "saved-strategies"
        ? (params.get("strategy") ?? undefined)
        : undefined,
    signIn,
    register: signIn && params.get("mode") === "register",
    landingSection: landingSections.find(([id]) => id === section)?.[0],
    href: signIn
      ? `#/sign-in${query ? `?${query}` : ""}`
      : workspaceHref(page, suffix),
  };
}
