import { expect, test } from "@playwright/test";

test("AEGIS shows one status card, a first-run guide, and a compact assistant button", async ({
  page,
}) => {
  await page.goto("/#/aegis");
  const status = page.getByRole("region", { name: "Agent status" });
  await expect(status).toContainText("Entries paused");
  await expect(status.getByText("PAPER", { exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Get started" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Paper performance" }),
  ).toHaveCount(0);
  await status.getByRole("button", { name: "Refresh HSKSwap data" }).click();
  await expect(page.getByRole("heading", { name: "Get started" })).toHaveCount(
    0,
  );
  await expect(status).toContainText("block ");
  await expect(status).toContainText(
    /Checking pool activity|Pools trading|pools inactive/,
  );
  await expect(
    page.getByRole("heading", { name: "Paper performance" }),
  ).toBeVisible();
  const launcher = page.getByRole("button", { name: "Open trading assistant" });
  const box = (await launcher.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(56); // Icon only until hovered.
  await launcher.hover();
  await expect(launcher).toContainText("Ask AEGIS");
});

test("a signed testnet runtime is never labelled paper, and shortcuts fit the account", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#/aegis");
  await page.getByRole("button", { name: "Refresh HSKSwap data" }).click();
  await expect(page.getByRole("heading", { name: "Get started" })).toHaveCount(
    0,
  );
  // Explicit read-response fixture: the same state, as the signed runtime reports it.
  await page.route(
    (url) => url.pathname === "/api/aegis/state",
    async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      await route.fulfill({
        response,
        json: {
          ...state,
          mode: "testnet",
          live_enabled: true,
          supported_assets: ["WHSK"],
          pnl: { ...state.pnl, nav_usdt: "0.27" },
        },
      });
    },
  );
  await page.reload();
  const status = page.getByRole("region", { name: "Agent status" });
  await expect(status.getByText("TESTNET", { exact: true })).toBeVisible();
  await expect(status).not.toContainText("virtual");
  await expect(
    page.getByRole("button", { name: "Start testnet agent" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Testnet performance" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "AEGIS on HSKSwap" }),
  ).toBeVisible();
  await expect(
    page.getByText("risk-controlled signed testnet execution"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open trading assistant" }).click();
  // 80% of the 10% ceiling on a 0.27 USDT account, and only assets with a testnet pool.
  await expect(
    page.getByRole("button", {
      name: "Set position size to 0.021 USDT and frequency to 30s",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Focus target assets on WHSK",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close AEGIS assistant" }).click();
  await page.goto("/#/aegis/wallet");
  await expect(page.getByRole("note").first()).toContainText(
    "signing on testnet chain 133",
  );
  expect(errors).toEqual([]);
});

test("a monitored feed that is catching up says connecting, and an outage says reconnecting", async ({
  page,
}) => {
  let error: string | null = null;
  await page.route(
    (url) => url.pathname === "/api/aegis/state",
    async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      await route.fulfill({
        response,
        json: {
          ...state,
          monitoring: true,
          data_status: "STALE",
          last_error: error,
        },
      });
    },
  );
  await page.goto("/#/aegis");
  const status = page.getByRole("region", { name: "Agent status" });
  await expect(status).toContainText("CONNECTING");
  await expect(status).not.toContainText("STALE");
  error = "All RPC endpoints unavailable";
  await expect(status).toContainText("RECONNECTING");
  await expect(page.getByRole("alert")).toContainText(
    "All RPC endpoints unavailable",
  );
});

test("a backend that never answers stops the opening spinner with a clear message", async ({
  page,
}) => {
  await page.route("**/api/session", () => {
    /* Never answered: this is what a hung backend looks like. */
  });
  await page.goto("/#/aegis");
  await expect(
    page.getByText("The backend did not respond", { exact: false }),
  ).toBeVisible({
    timeout: 20000,
  });
});
