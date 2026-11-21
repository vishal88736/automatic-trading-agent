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
  await page.goto("/workspace#/paper");
  await signIn(page, "alice");
  await expect(
    page.getByRole("heading", { name: "Paper Trading" }),
  ).toBeVisible();
  await expect(page.locator(".platform-product-balance")).toHaveText(
    "10000 virtual USDT",
  );

  await page.getByLabel("Quantity", { exact: true }).fill("0.001");
  await page.getByRole("button", { name: "Submit paper order" }).click();
  await expect(page.getByText("Order filled.")).toBeVisible();
  await expect(page.getByText("BUY 0.001 BTC", { exact: false })).toBeVisible();
  await expect(page.getByText("0.001 ·", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  const paper = page.getByRole("region", { name: "Paper trading portfolio" });
  await expect(paper.getByRole("cell", { name: "Manual" })).toBeVisible();
  await expect(
    paper.getByRole("cell", { name: "0.001", exact: true }),
  ).toBeVisible();
  const live = page.getByRole("region", { name: "Live trading portfolio" });
  await expect(live.getByText("Disabled", { exact: true })).toBeVisible();
  await expect(live.getByRole("table")).toHaveCount(0);

  await page
    .getByRole("link", { name: "Market Analysis and AI Insights", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Bitcoin (BTC/USD)" }),
  ).toBeVisible();
  await page.getByLabel("Asset name or symbol").fill("Ethereum");
  await page.getByRole("button", { name: "ETH", exact: true }).click();
  await page.getByRole("button", { name: "Add to watchlist" }).click();
  await expect(
    page.getByRole("button", { name: "Ethereum", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Crypto News", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Latest crypto news" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Filter by cryptocurrency" })
    .selectOption("BTC");
  await expect(page.getByText(/FIXTURE.*Retrieved/)).toBeVisible();

  await page
    .getByRole("link", { name: "Custom Strategy Builder", exact: true })
    .click();
  const chat = page.getByRole("region", { name: "Strategy chat" });
  await chat
    .getByLabel("Trading prompt")
    .fill("BTC RSI below 30 for entry and above 65 for exit.");
  await chat.getByRole("button", { name: "Send prompt" }).click();
  const preview = chat.getByRole("region", {
    name: "Validated strategy draft",
  });
  await expect(
    preview.getByRole("heading", { name: "Fixture RSI draft" }),
  ).toBeVisible();
  await expect(page.getByText("No saved strategies.")).toBeVisible();
  await chat.getByLabel("Trading prompt").fill("Use 3%");
  await chat.getByRole("button", { name: "Send prompt" }).click();
  await expect(preview).toContainText("3.00% of cash");
  await chat
    .getByRole("button", { name: "Save strategy", exact: true })
    .click();
  await expect(chat.getByRole("button", { name: "Saved v1" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Fixture RSI draft · BTC · v1" }),
  ).toBeVisible();
  await chat.getByRole("button", { name: "Edit strategy" }).click();
  await page.getByRole("button", { name: "Structured JSON" }).click();
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
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("link", { name: "Backtesting Lab", exact: true })
    .click();
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

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page, "bob");
  await expect(page.getByRole("alert")).toContainText(
    "Backtest is unavailable",
  );
  expect(page.url()).toBe(report);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("link", { name: "Strategies", exact: true }).click();
  await expect(page.getByText("No saved strategies.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reviewed RSI · BTC · v2" }),
  ).toHaveCount(0);
});
