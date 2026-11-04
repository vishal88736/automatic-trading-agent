import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("chat controls persist desk alerts, download history, navigate and prefill a human wallet review", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#/aegis");
  await page
    .getByRole("button", { name: "Refresh HSKSwap data", exact: true })
    .click();
  async function send(message: string, research = false) {
    const field = page.getByLabel(
      research ? "Message assistant" : "Message AEGIS",
      { exact: true },
    );
    if (!(await field.isVisible()))
      await page
        .getByRole("button", { name: "Open trading assistant", exact: true })
        .click();
    await field.fill(message);
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
          (research ? "/api/chat" : "/api/aegis/chat") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", {
        name: research ? "Send message" : "Send to AEGIS",
        exact: true,
      })
      .click();
    const result = await response;
    expect(result.ok(), await result.text()).toBeTruthy();
    return result.json();
  }
  const created = await send("Create a BTC alert above 100000");
  const identifier = created.data.alert.id;
  const alerts = await (await page.request.get("/api/alerts")).json();
  expect(
    alerts.items.some((item: { id: string }) => item.id === identifier),
  ).toBe(true);
  await send("Delete alert " + identifier);
  const download = page.waitForEvent("download");
  await send("Export trade history");
  const file = await download;
  expect(file.suggestedFilename()).toBe("aegis-trade-history.json");
  const archived = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(archived.items.length).toBeLessThanOrEqual(100);
  expect(archived.total).toBeGreaterThanOrEqual(archived.items.length);
  await send("Open research strategies");
  await expect(page).toHaveURL(/#\/strategies$/);
  await expect(
    page.getByRole("heading", { name: "Strategies", exact: true, level: 2 }),
  ).toBeVisible();
  await send("Deposit 2 USDT on testnet", true);
  await expect(page).toHaveURL(/#\/aegis\/wallet$/);
  await expect(
    page.getByLabel("AEGIS owner operation", { exact: true }),
  ).toHaveValue("deposit");
  await expect(
    page.getByLabel("AEGIS owner amount", { exact: true }),
  ).toHaveValue("2");
  await expect(
    page.getByText("Assistant request prefilled.", { exact: false }),
  ).toBeVisible();
  // Prefilling never prepares or submits a wallet transaction on its own.
  await expect(
    page.getByRole("button", { name: "Confirm step in wallet", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("chat emergency clearance requires the person's dialog confirmation", async ({
  page,
}) => {
  await page.goto("/#/aegis");
  await page
    .getByRole("button", { name: "Refresh HSKSwap data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Emergency stop", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh HSKSwap data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open trading assistant", exact: true })
    .click();
  await page
    .getByLabel("Message AEGIS", { exact: true })
    .fill("Clear emergency stop");
  await page
    .getByRole("button", { name: "Send to AEGIS", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review emergency-stop clearance",
    exact: true,
  });
  await expect(review).toBeVisible();
  expect(
    (await (await page.request.get("/api/aegis/state")).json()).emergency,
  ).toBe(true);
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    (await (await page.request.get("/api/aegis/state")).json()).emergency,
  ).toBe(true);
  await page
    .getByRole("button", { name: "Open trading assistant", exact: true })
    .click();
  await page
    .getByLabel("Message AEGIS", { exact: true })
    .fill("Clear emergency stop");
  await page
    .getByRole("button", { name: "Send to AEGIS", exact: true })
    .click();
  await review
    .getByRole("button", {
      name: "Confirm emergency-stop clearance",
      exact: true,
    })
    .click();
  await expect(review).toHaveCount(0);
  const state = await (await page.request.get("/api/aegis/state")).json();
  expect(state.emergency).toBe(false);
  expect(state.paused).toBe(true);
});
