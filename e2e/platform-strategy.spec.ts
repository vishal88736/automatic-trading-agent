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
  await page.goto("/#/platform/paper");
  await signIn(page, "alice");
  await expect(
    page.getByRole("heading", { name: "Paper Trading" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open virtual account" }).click();
  await expect(page.locator(".platform-product-balance")).toHaveText(
    "10000 virtual USDT",
  );

  await page.getByRole("link", { name: "Strategies", exact: true }).click();
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
  await page.getByRole("link", { name: "Strategies", exact: true }).click();
  await expect(page.getByText("No saved strategies.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reviewed RSI · BTC · v2" }),
  ).toHaveCount(0);
});
