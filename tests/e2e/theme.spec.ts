import { expect, test, type Page } from "@playwright/test";

const DARK_BG = "rgb(6, 10, 7)";
const LIGHT_BG = "rgb(245, 248, 245)";
const LIME = "rgb(181, 242, 72)";

async function stubMarkets(page: Page) {
  await page.route("**/platform/public/prices", (route) =>
    route.fulfill({ json: { source: "fixture", live: false, prices: {} } }),
  );
  await page.route("**/platform/public/prices/stream", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
}

async function stubSignedOutSession(page: Page) {
  await stubMarkets(page);
  await page.route("**/platform/health", (route) =>
    route.fulfill({ json: { productConfigured: true } }),
  );
  await page.route("**/platform/auth/session", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/platform/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
}

test("Krono defaults to light and persists an explicit theme choice", async ({
  page,
}) => {
  await stubSignedOutSession(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const root = page.locator("html");
  const landing = page.locator(".kx-landing");
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(landing).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("background-color", LIGHT_BG);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", DARK_BG);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", LIGHT_BG);
});

test("the landing fits every viewport and opens sign-up and sign-in", async ({
  page,
}) => {
  await stubSignedOutSession(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/#/dashboard");
  const hero = page.getByRole("heading", { level: 1 });
  await expect(hero).toContainText("Your strategy.");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/krono-mark.svg",
  );
  const landingBrand = page.getByRole("link", { name: "Krono", exact: true });
  await expect(landingBrand.locator(".krono-wordmark")).toBeVisible();
  const preview = page.locator(".kx-showcase");
  await expect(preview.getByText("Illustrative preview")).toBeVisible();
  await expect
    .poll(() =>
      preview
        .locator(".krono-mark")
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const start = page.getByRole("link", { name: /Start paper trading free/ });
  await expect(start).toHaveCSS("background-color", LIME);

  for (const [width, height] of [
    [1502, 726],
    [1366, 600],
    [850, 780],
    [390, 844],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(start).toBeVisible();
    await expect(landingBrand).toBeVisible();
    await expect(preview).toBeVisible();
  }
  const menu = page.getByRole("button", { name: "Open site navigation" });
  const nav = page.getByRole("navigation", { name: "About Krono" });
  await expect(nav).toBeHidden();
  await menu.click();
  await nav.getByRole("link", { name: "How it works" }).click();
  await expect(nav).toBeHidden();
  await expect(
    page.getByRole("heading", {
      name: "From idea to running agent in minutes",
    }),
  ).toBeInViewport();

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(start).toHaveCSS("background-color", LIME);
  await start.click();
  await expect(page).toHaveURL(/#\/sign-in\?mode=register$/);
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page.getByLabel("Display name")).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("background-color", DARK_BG);
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("link", { name: "Krono", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(hero).toBeVisible();
});

test("landing section links scroll to their content", async ({ page }) => {
  await stubSignedOutSession(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/dashboard");
  const nav = page.getByRole("navigation", { name: "About Krono" });
  await nav.getByRole("link", { name: "How it works" }).click();
  await expect(page).toHaveURL(/#\/dashboard\?section=workflow$/);
  await expect(
    page.getByRole("heading", {
      name: "From idea to running agent in minutes",
    }),
  ).toBeInViewport();
  await nav.getByRole("link", { name: "AI agents" }).click();
  await expect(page).toHaveURL(/#\/dashboard\?section=agents$/);
  await expect(
    page.getByRole("heading", { name: "Public leaderboard" }),
  ).toBeVisible();
});

test("the signed-in dashboard uses recorded equity and marks, with a responsive navigation rail", async ({
  page,
}) => {
  const account = {
    id: "paper-fixture",
    epoch: 1,
    currency: "USDT",
    cash: "7500",
  };
  const history = [
    {
      at: new Date(Date.now() - 48 * 3600000).toISOString(),
      equity: "10000",
      available_cash: "9000",
      unrealized_pnl: "0",
      realized_pnl: "0",
      daily_pnl: "0",
      drawdown: "0.01",
    },
    {
      at: new Date(Date.now() - 3600000).toISOString(),
      equity: "12500",
      available_cash: "7000",
      unrealized_pnl: "2500",
      realized_pnl: "0",
      daily_pnl: "2500",
      drawdown: "0",
    },
  ];
  let marked = true;
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.route("**/platform/health", (route) =>
    route.fulfill({ json: { productConfigured: true } }),
  );
  await page.route("**/platform/auth/session", (route) =>
    route.fulfill({
      json: { userId: "theme-fixture", email: "theme@fixture.test" },
    }),
  );
  await page.route("**/platform/paper-account", (route) =>
    route.fulfill({ json: { account } }),
  );
  await page.route("**/platform/paper-portfolio", (route) =>
    route.fulfill({
      json: {
        epoch: account.epoch,
        cash: account.cash,
        equity: marked ? "12500" : null,
        available_cash: "7000",
        realized_pnl: "0",
        unrealized_pnl: marked ? "2500" : null,
        daily_pnl: marked ? "2500" : null,
        drawdown: marked ? "0" : null,
        holdings: [
          {
            asset: "BTC",
            quantity: "0.05",
            mark: marked ? "5000" : null,
            allocation: marked ? "0.4" : null,
          },
        ],
        positions: [
          {
            asset: "BTC",
            agent_id: "agent-fixture",
            agent_name: "BTC paper agent",
            quantity: "0.05",
            mark: marked ? "5000" : null,
            unrealized_pnl: marked ? "2500" : null,
          },
        ],
        history,
        emergency_stop: false,
      },
    }),
  );
  await page.route("**/platform/paper-orders", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/platform/paper-agents", (route) =>
    route.fulfill({ json: { items: [], worker_online: true } }),
  );
  await stubMarkets(page);
  const prices = [
    ["BTC", "98100"],
    ["ETH", "3525"],
    ["SOL", "189"],
  ].flatMap(([asset, price]) =>
    [0, 1].map((step) => ({
      asset,
      price: String(Number(price) + step),
      high_24h: price,
      low_24h: price,
      change_24h: "0.0123",
      at: new Date(Date.now() + step * 1000).toISOString(),
    })),
  );
  await page.route("**/platform/public/prices/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: prices
        .map((price) => `event: price\ndata: ${JSON.stringify(price)}\n\n`)
        .join(""),
    }),
  );
  await page.route("**/platform/paper-market/*", (route) =>
    route.fulfill({
      json: {
        market: {
          status: "STALE",
          source: "fixture",
          price: null,
          candles: [],
        },
      },
    }),
  );

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/#/dashboard");
  const workspace = page.locator(".unified-workspace");
  await expect(workspace).toHaveCSS("background-color", LIGHT_BG);
  await expect(
    page
      .getByRole("link", { name: "Krono", exact: true })
      .locator(".krono-wordmark"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(workspace).toHaveCSS("background-color", DARK_BG);
  const positions = page.getByRole("region", {
    name: "Paper trading portfolio",
  });
  await expect(
    positions.getByRole("link", { name: "BTC paper agent" }),
  ).toHaveAttribute("href", "#/agents?agent=agent-fixture");
  await expect(
    positions.getByRole("cell", { name: "$5,000.00" }),
  ).toBeVisible();
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  await expect(
    sidebar.getByRole("link", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const equity = page.getByRole("img", {
    name: "Recorded paper equity, 2 snapshots",
  });
  await expect(equity).toBeVisible();
  const kpis = page.locator(".dashboard-kpis");
  await expect(kpis.locator(".dashboard-metric-value")).toHaveText([
    "$12,500.00",
    "$7,000.00",
    "$2,500.00",
    "$0.00",
  ]);
  await expect(kpis.locator(".sparkline")).toHaveCount(4);
  await expect(kpis.locator(".dashboard-trend").first()).toHaveText("+25.00%");
  await expect(kpis.locator(".dashboard-trend").nth(1)).toHaveAttribute(
    "data-direction",
    "down",
  );
  const ticker = page.getByRole("region", { name: "Live prices" });
  await expect(ticker.locator(".sparkline")).toHaveCount(3);
  expect((await kpis.boundingBox())!.y).toBeLessThan(
    (await equity.boundingBox())!.y,
  );
  expect((await sidebar.boundingBox())!.width).toBeLessThan(
    (await equity.boundingBox())!.x,
  );

  const snapshot = page.getByRole("slider", {
    name: "Inspect equity snapshot",
  });
  await expect(snapshot).toHaveAttribute("aria-valuetext", /^\$12,500\.00 at /);
  await equity.hover({ position: { x: 24, y: 120 } });
  await expect(page.locator(".equity-point-tooltip")).toContainText(
    "$10,000.00",
  );
  await snapshot.focus();
  await snapshot.press("Home");
  await expect(snapshot).toHaveAttribute("aria-valuetext", /^\$10,000\.00 at /);
  const range = page.getByRole("group", { name: "Equity period" });
  await range.getByRole("button", { name: "Past 24 hours" }).click();
  await expect(
    page.getByRole("img", { name: "Recorded paper equity, 1 snapshot" }),
  ).toBeVisible();

  const allocation = page.locator(".dashboard-allocation");
  await expect(allocation.locator(".dashboard-allocation-slice")).toHaveCount(
    2,
  );
  await expect(allocation).toContainText("60.0%");
  await expect(allocation).toContainText("40.0%");
  await expect(allocation).toContainText("$5,000.00 · 0.05 BTC");
  marked = false;
  await page.getByRole("button", { name: "Refresh account" }).click();
  await expect(allocation).toContainText(
    "Allocation requires fresh prices for every holding.",
  );
  await expect(allocation.locator(".dashboard-allocation-ring")).toHaveCount(0);
  await expect(positions.getByText("Awaiting price")).toBeVisible();

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(workspace).toHaveCSS("background-color", LIGHT_BG);
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await expect(
    page.getByRole("link", { name: "Krono overview" }),
  ).toBeVisible();
  expect(
    await ticker.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeGreaterThan(0);
  await ticker.getByRole("link", { name: /SOL/ }).scrollIntoViewIfNeeded();
  expect(
    await ticker.evaluate((element) => element.scrollLeft),
  ).toBeGreaterThan(0);
  const menu = page.getByRole("button", { name: "Open navigation" });
  await expect(sidebar).toBeHidden();
  await menu.click();
  await sidebar.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(menu).toBeFocused();
  await expect(sidebar).toBeHidden();
});
