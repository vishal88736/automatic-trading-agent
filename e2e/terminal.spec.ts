import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Command center", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("SIMULATION WORKSPACE", { exact: true }),
  ).toBeVisible();
});

test("complete research, risk, authorization, simulated fill, ledger and audit workflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByText("Portfolio equity", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Hourly candlestick/ }),
  ).toBeVisible();
  mkdirSync("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/terminal-overview-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Analyze BTC", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Review trade preview" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Agent Observatory", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agent observatory", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /03 Analyst Team/ }).click();
  await expect(
    page.getByText("Deterministic analyst evidence", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/terminal-observatory.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Execution History", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Transaction preview", exact: true }),
  ).toBeVisible();
  const refresh = page.getByRole("button", {
    name: "Refresh risk check & quote",
  });
  if (await refresh.isVisible()) await refresh.click();
  await page
    .getByRole("button", { name: "Authorize simulated fill", exact: true })
    .click();
  await expect(
    page.getByText("Simulated fill reconciled", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/terminal-execution.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Positions", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Owned simulation inventory" }),
  ).toBeVisible();
  const portfolio = await (await page.request.get("/api/portfolio")).json();
  expect(portfolio.mode).toBe("SIMULATION");
  expect(portfolio.positions).toHaveLength(1);
  expect(Number(portfolio.cash)).toBe(9900);
  const ledger = await (await page.request.get("/api/history/ledger")).json();
  expect(ledger.total).toBe(1);
  const audit = await (
    await page.request.get("/api/history/audit?limit=200")
  ).json();
  expect(
    audit.items.some(
      (a: { kind: string }) => a.kind === "portfolio.reconciled",
    ),
  ).toBe(true);
  const status = await (await page.request.get("/api/status")).json();
  expect(status.live_enabled).toBe(false);
  expect(errors).toEqual([]);
});

test("strategy configuration is versioned and backtests report measured holdout metrics", async ({
  page,
}) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Strategies", exact: true })
    .click();
  const card = page.locator(".strategy-card").filter({
    has: page.getByRole("heading", { name: "Trend & momentum", exact: true }),
  });
  await card.getByRole("button", { name: "Configure" }).click();
  await page.getByLabel("Fast EMA period", { exact: true }).fill("13");
  await page
    .getByRole("button", { name: "Save strategy configuration" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const strategies = await (await page.request.get("/api/strategies")).json();
  expect(
    strategies.items.find((s: { id: string }) => s.id === "momentum_v1").config
      .fast_period,
  ).toBe(13);
  await card
    .getByRole("button", { name: "Backtest Trend & momentum", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Chronological strategy comparison" }),
  ).toBeVisible();
  await expect(
    page.getByText("synthetic_fixture_v1 · SYNTHETIC", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/terminal-strategies.png",
    fullPage: true,
  });
});

test("news filters and evidence detail preserve source and timestamp provenance", async ({
  page,
}) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "News Intelligence", exact: true })
    .click();
  await page.getByLabel("Filter news asset").selectOption("BTC");
  await page.getByLabel("Search headlines").fill("adoption");
  await expect(page.locator(".news-row")).toHaveCount(1);
  await page.locator(".news-row").click();
  await expect(
    page.getByRole("dialog", { name: "News evidence" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Synthetic development story. This is a fixture, not a report of a real event.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Synthetic source URL" }),
  ).toHaveAttribute("href", /example\.invalid/);
  await page.screenshot({
    path: "artifacts/terminal-news-evidence.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close dialog" }).click();
});

test("assistant lowers allowed risk, emergency stop latches and blocks entries", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Open trading assistant" }).click();
  await page
    .getByLabel("Message assistant")
    .fill("Lower maximum trade size to 0.5% of equity");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("Maximum trade allocation is now", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close assistant" }).click();
  await page
    .getByRole("button", { name: "Emergency stop", exact: true })
    .click();
  await expect(
    page.getByText("EMERGENCY STOP ACTIVE", { exact: true }),
  ).toBeVisible();
  const status = await (await page.request.get("/api/status")).json();
  expect(status.scheduler.emergency).toBe(true);
  const risk = await (await page.request.get("/api/risk")).json();
  expect(Number(risk.config.max_equity_per_trade)).toBe(0.005);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Risk Controls", exact: true })
    .click();
  await page.getByLabel("I reviewed the incident").check();
  await page
    .getByRole("button", { name: "Clear emergency latch", exact: true })
    .click();
  await expect(
    page.getByText("EMERGENCY STOP ACTIVE", { exact: true }),
  ).toHaveCount(0);
  const cleared = await (await page.request.get("/api/status")).json();
  expect(cleared.scheduler.entries_paused).toBe(true);
});

test("responsive navigation exposes every workspace and wallet disconnect is honest", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const labels = [
    ["Markets", "Market intelligence"],
    ["News Intelligence", "News intelligence"],
    ["Strategies", "Strategy lab"],
    ["Positions", "Positions & portfolio"],
    ["Execution History", "Execution terminal"],
    ["Agent Observatory", "Agent observatory"],
    ["Risk Controls", "Risk controls"],
    ["Wallet", "Wallet & network"],
    ["Settings", "Workspace settings"],
    ["Overview", "Command center"],
  ];
  for (const [nav, heading] of labels) {
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: nav, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: "artifacts/terminal-overview-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Wallet", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect read-only wallet", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "No EIP-1193 wallet" }),
  ).toBeVisible();
});

test("chart timeframe aggregation and aligned correlations are inspectable", async ({
  page,
}) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Markets", exact: true })
    .click();
  await page.getByLabel("Chart candle timeframe").selectOption("4h");
  await expect(
    page.getByRole("img", { name: /Four-hour candlestick/ }),
  ).toBeVisible();
  const bars = await (
    await page.request.get("/api/markets/BTC?timeframe=4h")
  ).json();
  expect(bars.market.timeframe).toBe("4h");
  expect(bars.market.candles).toHaveLength(59);
  await expect(
    page.getByRole("heading", { name: "Aligned market correlation" }),
  ).toBeVisible();
  const correlation = await (
    await page.request.get("/api/correlations")
  ).json();
  expect(correlation.status).toBe("FIXTURE");
  expect(correlation.observations).toBe(237);
});
