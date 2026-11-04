import { expect, test } from "@playwright/test";

test("trade preview shows total cash debit and refuses confirmation after saved preferences change", async ({
  page,
}) => {
  let csrf = "";
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/session" && response.ok())
      csrf = (await response.json()).csrf_token;
  });
  await page.goto("/#/aegis");
  await page
    .getByRole("button", { name: "Refresh HSKSwap data", exact: true })
    .click();
  let state = await (await page.request.get("/api/aegis/state")).json();
  if (state.positions.length || state.emergency) {
    if (!state.emergency)
      await page
        .getByRole("button", { name: "Emergency stop", exact: true })
        .click();
    for (let attempt = 0; attempt < 6; attempt++) {
      await page
        .getByRole("button", { name: "Refresh HSKSwap data", exact: true })
        .click();
      if (
        !(await (await page.request.get("/api/aegis/state")).json()).positions
          .length
      )
        break;
    }
    const clear = page.getByRole("button", {
      name: "Review and clear stop",
      exact: true,
    });
    await expect(clear).toBeEnabled();
    await clear.click();
    state = await (await page.request.get("/api/aegis/state")).json();
  }
  if (state.fills.length)
    await expect
      .poll(() => Date.now() / 1000 - state.fills[0].created_at, {
        timeout: 35000,
        message: "Honour the entry cooldown after the last fixture fill",
      })
      .toBeGreaterThanOrEqual(31);
  // This test doesn't trade or change active automation; it only reviews and cancels.
  await expect(
    page.getByRole("region", { name: "Entry readiness", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open trading assistant", exact: true })
    .click();
  await page
    .getByLabel("Message AEGIS", { exact: true })
    .fill("Buy 0.5 USDT of WHSK");
  const request = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/aegis/chat" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Send to AEGIS", exact: true })
    .click();
  const answer = await (await request).json();
  const dialog = page.getByRole("dialog", {
    name: "Review paper buy of WHSK",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog
      .locator(".trade-facts div")
      .filter({ has: page.getByText("Trade input", { exact: true }) }),
  ).toContainText("0.5 USDT");
  await expect(
    dialog
      .locator(".trade-facts div")
      .filter({ has: page.getByText("You spend", { exact: true }) }),
  ).toContainText("0.51 USDT");
  const changed = await page.request.put("/api/aegis/settings", {
    headers: { "X-Terminal-CSRF": csrf },
    data: {
      expected_version: state.params_version,
      patch: {
        stop_loss_pct: state.params.stop_loss_pct === "1.5" ? "2" : "1.5",
      },
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Confirm buy", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText(
    "Trading settings changed",
  );
  const refused = await page.request.post("/api/aegis/control", {
    headers: { "X-Terminal-CSRF": csrf },
    data: { action: "trade_confirm", confirmation: answer.data.confirmation },
  });
  expect(refused.status()).toBe(409);
  const after = await (await page.request.get("/api/aegis/state")).json();
  expect(after.fills.length).toBe(state.fills.length);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const restore = await page.request.put("/api/aegis/settings", {
    headers: { "X-Terminal-CSRF": csrf },
    data: {
      expected_version: after.params_version,
      patch: { stop_loss_pct: state.params.stop_loss_pct },
    },
  });
  expect(restore.ok()).toBe(true);
});
