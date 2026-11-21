import { expect, test, type Page } from "@playwright/test";

async function stubSignedOutSession(page: Page) {
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

test("Krono follows the system theme and persists a user choice", async ({
  page,
}) => {
  await stubSignedOutSession(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const root = page.locator("html");
  const landing = page.locator(".krono-landing");
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(landing).toHaveCSS("background-color", "rgb(247, 243, 235)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(landing).toHaveCSS("background-color", "rgb(16, 16, 18)");

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(landing).toHaveCSS("background-color", "rgb(247, 243, 235)");
});

test("the landing uses the workspace palette, fits the viewport and opens sign-in", async ({
  page,
}) => {
  await stubSignedOutSession(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const heroImage = page.waitForResponse("**/art/krono-sapphire-terminal.webp");
  await page.goto("/#/dashboard");
  const hero = page.getByRole("heading", {
    name: "Build and test crypto strategies.",
    exact: true,
  });
  await expect(hero).toBeVisible();
  expect((await heroImage).ok()).toBe(true);

  const landing = page.locator(".krono-landing");
  const artwork = page.locator(".landing-art img");
  const start = page.getByRole("link", { name: "Get started" });
  await expect(landing).toHaveCSS("background-color", "rgb(16, 16, 18)");
  await expect(start).toHaveCSS("background-color", "rgb(217, 185, 128)");
  await expect(landing.locator("canvas")).toHaveCount(0);
  await expect
    .poll(() =>
      artwork.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  for (const [width, height] of [
    [1502, 726],
    [1366, 600],
    [850, 780],
    [390, 844],
    [365, 720],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    const heroBounds = (await page.locator(".landing-hero").boundingBox())!;
    const artBounds = (await artwork.boundingBox())!;
    expect(heroBounds.width).toBe(width);
    expect(heroBounds.height).toBeGreaterThanOrEqual(height);
    expect(artBounds.x).toBeGreaterThanOrEqual(0);
    expect(artBounds.x + artBounds.width).toBeLessThanOrEqual(width);
    expect(artBounds.y + artBounds.height).toBeLessThanOrEqual(
      heroBounds.height,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(start).toBeInViewport({ ratio: 1 });
  }
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(landing).toHaveCSS("background-color", "rgb(247, 243, 235)");
  await expect(start).toHaveCSS("background-color", "rgb(118, 84, 34)");
  await expect(artwork).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await start.click();
  await expect(page).toHaveURL(/#\/sign-in$/);
  await expect(
    page.getByRole("heading", { name: "Welcome to your workspace" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  await expect(page.locator(".unified-workspace")).toHaveCSS(
    "background-color",
    "rgb(247, 243, 235)",
  );
  await expect(hero).toHaveCount(0);
  await expect(artwork).toHaveCount(0);
  await page.goBack();
  await expect(hero).toBeVisible();
});

test("landing section links focus the selected content and preserve protected destinations", async ({
  page,
}) => {
  await stubSignedOutSession(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/dashboard");
  await page.getByRole("link", { name: "See how it works" }).click();
  await expect(page).toHaveURL(/#\/dashboard\?section=workflow$/);
  const workflow = page.getByRole("region", {
    name: "From strategy to paper trading",
  });
  await expect(workflow).toBeFocused();
  await expect(
    workflow.getByRole("link", { name: /Build your rules/ }),
  ).toHaveAttribute("href", "#/builder");
  await workflow.getByRole("link", { name: /Backtest a strategy/ }).click();
  await expect(page).toHaveURL(/#\/backtests$/);
  await expect(
    page.getByRole("heading", { name: "Welcome to your workspace" }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);

  await page.goBack();
  await expect(workflow).toBeFocused();
  await page
    .getByRole("navigation", { name: "Krono links" })
    .getByRole("link", { name: "AI agents", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/dashboard\?section=agents$/);
  const agents = page.getByRole("region", {
    name: "Run an agent while you’re away",
  });
  await expect(agents).toBeFocused();
  await expect(
    agents.getByRole("link", { name: "Explore AI agents" }),
  ).toHaveAttribute("href", "#/agents");
  await page
    .getByRole("navigation", { name: "Krono links" })
    .getByRole("link", { name: "Workspace tools" })
    .click();
  await expect(page).toHaveURL(/#\/dashboard\?section=tools$/);
  await page.reload();
  await expect(page.locator("#landing-tools")).toBeFocused();
  const cards = page.locator(".landing-tool-card");
  await expect(cards).toHaveCount(2);
  await expect(
    cards.first().getByRole("link", { name: "Read crypto news" }),
  ).toHaveAttribute("href", "#/news");
  await expect(
    cards.last().getByRole("link", { name: "View portfolio" }),
  ).toHaveAttribute("href", "#/portfolio");
  await expect
    .poll(() =>
      cards
        .locator("img")
        .evaluateAll(
          (images) =>
            images.filter(
              (image) =>
                image instanceof HTMLImageElement && image.naturalWidth > 0,
            ).length,
        ),
    )
    .toBe(2);
  await expect(
    page.getByRole("link", { name: "Ethereum (ETH)" }),
  ).toHaveAttribute("href", "#/markets?asset=ETH");
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
    { at: new Date(Date.now() - 48 * 3600000).toISOString(), equity: "10000" },
    { at: new Date(Date.now() - 3600000).toISOString(), equity: "12500" },
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
  await expect(workspace).toHaveCSS("background-color", "rgb(16, 16, 18)");
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
    sidebar.getByRole("link", { name: "Dashboard", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const equity = page.getByRole("img", {
    name: "Recorded paper equity, 2 snapshots",
  });
  await expect(equity).toBeVisible();
  expect((await sidebar.boundingBox())!.width).toBeLessThan(
    (await equity.boundingBox())!.x,
  );

  const snapshot = page.getByRole("slider", {
    name: "Inspect equity snapshot",
  });
  await expect(snapshot).toHaveAttribute("aria-valuetext", /^\$12,500\.00 at /);
  await snapshot.focus();
  await snapshot.press("Home");
  await expect(snapshot).toHaveAttribute("aria-valuetext", /^\$10,000\.00 at /);
  await page
    .getByRole("combobox", { name: "Equity period" })
    .selectOption("day");
  await expect(
    page.getByRole("img", { name: "Recorded paper equity, 1 snapshot" }),
  ).toBeVisible();

  const allocation = page.locator(".dashboard-allocation");
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
  await expect(workspace).toHaveCSS("background-color", "rgb(247, 243, 235)");
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  const menu = page.getByRole("button", { name: "Toggle navigation" });
  await expect(sidebar).toBeHidden();
  await menu.click();
  await sidebar.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(menu).toBeFocused();
  await expect(sidebar).toBeHidden();
});
