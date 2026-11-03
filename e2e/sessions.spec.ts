import { expect, test } from "@playwright/test";
import { openWorkspace } from "./navigation";

// Explicit read-response fixture shaped like /api/aegis/sessions; no trade is created.
const summary = {
  id: "e5bb6c71-1efd-4ec6-97d3-e103ace2e481",
  number: 1,
  status: "ended",
  started_at: 1793727423,
  ended_at: 1793729959,
  end_reason: "panic",
  end_label: "PANIC emergency stop",
  duration_seconds: 2536,
  start_nav_usdt: "100",
  end_nav_usdt: "99.877096",
  net_pnl_usdt: "-0.122904",
  net_pnl_pct: "-0.122904",
  realized_pnl_usdt: "-0.122904",
  trades: 2,
  entries: 1,
  exits: 1,
  wins: 0,
  losses: 1,
  assets: ["WBTC"],
  strategies: ["momentum_v1"],
};
const detail = {
  ...summary,
  settings: {
    active_strategies: ["momentum_v1"],
    target_assets: ["WBTC"],
    risk_level: "balanced",
    position_size_pct: "5",
    stop_loss_pct: "5",
    take_profit_pct: "10",
    tick_seconds: 30,
  },
  settings_source: "recorded at session start",
  positions: [
    {
      asset: "WBTC",
      strategy_id: "momentum_v1",
      entry_at: 1793727441,
      entry_price_usdt: "77784.69",
      cost_usdt: "5",
      exit_at: 1793730002,
      exit_price_usdt: "77131.24",
      exit_reason: "panic unwind",
      status: "closed",
      realized_pnl_usdt: "-0.062004",
      return_pct: "-1.24",
      holding_seconds: 2561,
    },
  ],
  strategy_breakdown: [
    {
      strategy_id: "momentum_v1",
      positions: 1,
      realized_pnl_usdt: "-0.062004",
    },
  ],
  activity: {
    market_checks: 66,
    strategy_evaluations: 990,
    holds: 412,
    blocked: 576,
  },
  fills: [],
  timeline: [
    {
      id: "a",
      at: 1793727423,
      kind: "start",
      title: "Agent started",
      detail: "Entries enabled.",
    },
    {
      id: "b",
      at: 1793727441,
      kind: "buy",
      title: "Bought WBTC",
      detail: "EMA, MACD, RSI and volume confirmed.",
      asset: "WBTC",
      quantity: "0.00006428",
      notional_usdt: "5",
      price_usdt: "77784.69",
      confidence: "0.65",
      strategy_id: "momentum_v1",
      strategy_name: "Momentum Trading",
    },
    {
      id: "c",
      at: 1793729959,
      kind: "stop",
      title: "PANIC stop",
      detail: "Entries blocked.",
    },
    {
      id: "d",
      at: 1793730002,
      kind: "sell",
      title: "Sold WBTC",
      detail: "Exit: panic unwind",
      asset: "WBTC",
      quantity: "0.00006428",
      notional_usdt: "4.957996",
      price_usdt: "77131.24",
      realized_pnl_usdt: "-0.062004",
    },
  ],
  series: [
    { at: 1793727441, nav_usdt: "99.99" },
    { at: 1793728441, nav_usdt: "99.95" },
    { at: 1793730002, nav_usdt: "99.877096" },
  ],
};

test("sessions are reachable from the sidebar and explain each trade with its value", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === "/api/aegis/sessions",
    (route) => route.fulfill({ json: { items: [summary], mode: "paper" } }),
  );
  await page.route(
    (url) => url.pathname === `/api/aegis/sessions/${summary.id}`,
    (route) => route.fulfill({ json: detail }),
  );
  await page.goto("/");
  await openWorkspace(page, "Sessions");
  await expect(page.getByRole("heading", { name: "Session #1" })).toBeVisible();
  await expect(page.locator(".session-kpis")).toContainText("−0.1229 USDT");
  const steps = page.locator(".session-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(1)).toContainText("Bought WBTC");
  await expect(steps.nth(1)).toContainText("77,784.69 USDT");
  await expect(steps.nth(1)).toContainText("Momentum Trading");
  await expect(steps.nth(3)).toContainText("−0.062 USDT");
  await expect(page.locator(".session-positions tbody tr")).toHaveCount(1);
  await expect(page.locator(".session-settings")).toContainText("balanced");
  const chart = page.locator(".session-chart svg");
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".session-tooltip")).toContainText("Portfolio");
  for (const width of [1504, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
});

test("an empty ledger explains how a session starts", async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/api/aegis/sessions",
    (route) => route.fulfill({ json: { items: [], mode: "paper" } }),
  );
  await page.goto("/#/sessions");
  await expect(page.getByText("No sessions yet")).toBeVisible();
});
