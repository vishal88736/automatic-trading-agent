import { expect, test, type Page } from "@playwright/test";

const productConfig = process.env.KRONO_E2E_PRODUCT_API_URL;
test.skip(!productConfig, "Requires the isolated PostgreSQL product API");

async function signIn(page: Page, user: "alice" | "bob") {
  await page.getByLabel("Email", { exact: true }).fill(`${user}@fixture.test`);
  await page.getByLabel("Password", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("Fund, version, backtest, and isolate a tenant strategy", async ({
  page,
}) => {
  await page.goto("/#/paper");
  await signIn(page, "alice");
  await expect(
    page.getByRole("heading", { name: "Paper Trading" }),
  ).toBeVisible();
  await expect(page.locator(".platform-product-balance")).toHaveText(
    "10000 virtual USDT",
  );
  const balance = page.getByRole("region", { name: "Virtual balance" });
  const ticket = page.locator(".kx-paper-ticket");
  await expect(ticket).toBeVisible();
  const balanceBox = (await balance.boundingBox())!;
  const ticketBox = (await ticket.boundingBox())!;
  expect(ticketBox.x).toBeGreaterThan(balanceBox.x);
  expect(ticketBox.y).toBeCloseTo(balanceBox.y, 0);

  await page.getByLabel("Quantity", { exact: true }).fill("0.001");
  await page.getByRole("button", { name: "Submit paper order" }).click();
  await expect(page.getByText("Order filled.")).toBeVisible();
  await expect(page.getByText("BUY 0.001 BTC", { exact: false })).toBeVisible();
  await expect(page.getByText("0.001 ·", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  const paper = page.getByRole("region", { name: "Paper trading portfolio" });
  await expect(paper.getByRole("cell", { name: "Manual" })).toBeVisible();
  await expect(
    paper.getByRole("cell", { name: "0.001", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Live dashboard", exact: true }).click();
  const live = page.getByRole("region", { name: "Live trading dashboard" });
  await expect(
    live.getByText("Live trading is disabled on this server."),
  ).toBeVisible();
  await expect(live.getByRole("table")).toHaveCount(0);

  await page
    .getByRole("link", { name: "Markets & AI Insights", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Bitcoin (BTC/USD)" }),
  ).toBeVisible();
  await expect(page.getByLabel("Asset name or symbol")).toBeHidden();
  const browseMarkets = page.getByText("Browse markets", { exact: true });
  await browseMarkets.click();
  await page.getByLabel("Asset name or symbol").fill("Ethereum");
  await page.getByRole("button", { name: "ETH", exact: true }).click();
  await page.getByRole("button", { name: "Add to watchlist" }).click();
  await expect(
    page.getByRole("button", { name: "Ethereum", exact: true }),
  ).toBeVisible();
  await browseMarkets.click();
  await page.getByLabel("Asset name or symbol").fill("ADA");
  await page.getByRole("button", { name: "ADA", exact: true }).click();
  await expect(page.getByLabel("Asset name or symbol")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "ADA (ADA/USD)" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add to watchlist" }).click();
  await expect(
    page.getByRole("button", { name: "Remove from watchlist" }),
  ).toBeVisible();
  await browseMarkets.click();
  await page.getByLabel("Asset name or symbol").fill("BTC");
  await page.getByRole("button", { name: "BTC", exact: true }).click();
  await page.getByRole("button", { name: "Generate insight for BTC" }).click();
  await expect(
    page.getByRole("heading", { name: "Chart analysis" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "News analysis" }),
  ).toBeVisible();
  await expect(page.getByText("BTC chart and news at a glance.")).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({
      hasText: "Momentum and volatility indicators were available.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Portfolio", exact: true }),
  ).toHaveCount(0);
  await page.getByText(/Headlines used/).click();
  await expect(
    page.getByRole("link", { name: /Fixture research: Bitcoin adoption/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Crypto News", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Latest crypto news" }),
  ).toBeVisible();
  const newsFilter = page.getByRole("combobox", {
    name: "Filter by cryptocurrency",
  });
  await expect(newsFilter.getByRole("option", { name: "ADA" })).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Filter by cryptocurrency" })
    .selectOption("BTC");
  await expect(
    page.getByRole("heading", { name: /Fixture research: Bitcoin adoption/ }),
  ).toBeVisible();

  await page
    .getByRole("link", { name: "AI Strategy Builder", exact: true })
    .click();
  const chat = page.getByRole("region", { name: "Strategy chat" });
  await chat
    .getByLabel("Trading prompt")
    .fill("Buy BTC when RSI is below 30 and sell when RSI is above 65.");
  await chat.getByRole("button", { name: "Send prompt" }).click();
  const preview = chat.getByRole("region", {
    name: "Validated strategy draft",
  });
  await expect(
    chat.getByText(
      "What percentage of available cash should the agent use per entry?",
    ),
  ).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(
    chat.getByRole("button", { name: "Run as paper agent" }),
  ).toHaveCount(0);
  await chat.getByLabel("Trading prompt").fill("5%");
  await chat.getByRole("button", { name: "Send prompt" }).click();
  await expect(
    chat.getByText(
      "What percentage below the entry price should trigger the stop loss?",
    ),
  ).toBeVisible();
  await expect(preview).toHaveCount(0);
  await chat.getByLabel("Trading prompt").fill("4%");
  await chat.getByRole("button", { name: "Send prompt" }).click();
  await expect(
    preview.getByRole("heading", { name: "BTC strategy" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Saved strategies" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Strategy template" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Structured JSON" }),
  ).toHaveCount(0);
  await chat.getByLabel("Trading prompt").fill("Use 3% per trade");
  await chat.getByRole("button", { name: "Send prompt" }).click();
  await expect(preview).toContainText("3.00% of cash");
  await chat
    .getByRole("button", { name: "Save strategy", exact: true })
    .click();
  await expect(chat.getByRole("button", { name: "Saved v1" })).toBeDisabled();
  await expect(chat.getByRole("button", { name: "Edit strategy" })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "My strategies", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "BTC strategy · BTC · v1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "BTC strategy · BTC · v1" }).click();
  await expect(page.getByLabel("Strategy JSON")).toHaveValue(
    /"cash_fraction": "0.03"/,
  );

  await page
    .getByRole("combobox", { name: "Strategy template" })
    .selectOption("MACD crossover");
  await page.getByRole("button", { name: "Add entry rule" }).click();
  await page
    .getByRole("combobox", { name: "Asset", exact: true })
    .selectOption("ETH");
  await page
    .getByRole("button", { name: "Structured JSON", exact: true })
    .click();
  await expect(page.getByLabel("Strategy JSON")).toHaveValue(/"asset": "ETH"/);
  await expect(page.getByLabel("Strategy JSON")).toHaveValue(/macd_signal/);
  await page.getByRole("button", { name: "New strategy" }).click();
  const editor = page.getByLabel("Strategy JSON");
  const save = page.getByRole("button", { name: "Save strategy", exact: true });
  await expect(editor).toBeEnabled();
  await save.click();
  await expect(page.getByText("Saved version 1.")).toBeVisible();

  const versionOne = JSON.parse(await editor.inputValue());
  await editor.fill(JSON.stringify({ ...versionOne, name: "Reviewed RSI" }));
  await save.click();
  await expect(page.getByText("Saved version 2.")).toBeVisible();
  await page.getByRole("button", { name: "Version history" }).click();
  await page.getByLabel("Compare saved version").selectOption("1");
  await expect(page.getByLabel("Selected strategy version")).toContainText(
    "BTC RSI rules",
  );

  await page.getByRole("button", { name: "Save as copy" }).click();
  await expect(page.getByText("Saved version 1.")).toBeVisible();
  await page.getByRole("button", { name: "Archive strategy" }).click();
  await expect(page.getByText("Strategy archived.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reviewed RSI · BTC · v2" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(392);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Reviewed RSI · BTC · v2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Backtesting", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Strategy", exact: true })
    .selectOption({
      label: "Reviewed RSI · BTC/USD · v2",
    });
  await page.getByLabel("Start date").fill("2026-01-15");
  await page.getByLabel("End date (exclusive)").fill("2026-01-22");
  await page.getByRole("button", { name: "Run backtest" }).click();
  await expect(
    page.getByRole("heading", { name: "Replay report" }),
  ).toBeVisible();
  await expect(page.getByText("Total return", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "In-sample" }).click();
  await expect(
    page.getByRole("img", { name: /Backtest equity/ }),
  ).toBeVisible();
  await page.getByText("Assumptions and dataset", { exact: true }).click();
  await expect(page.getByText("SHA-256", { exact: false })).toBeVisible();
  const report = page.url();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Replay report" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.goto(report);
  await signIn(page, "bob");
  await expect(page.getByRole("alert")).toContainText(
    "Backtest is unavailable",
  );
  expect(page.url()).toBe(report);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "My strategies", exact: true }).click();
  await expect(page.getByText("No saved strategies.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reviewed RSI · BTC · v2" }),
  ).toHaveCount(0);
});
