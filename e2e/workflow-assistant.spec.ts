import { expect, test } from "@playwright/test";

// Sorted last on purpose: its fills start the shared ledger's 30-second entry cooldown.
test("a newcomer gets guided in chat and a trade runs only after reviewing it", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#/aegis");
  await page.getByRole("button", { name: "Refresh HSKSwap data" }).click();
  const opening = await (await page.request.get("/api/aegis/state")).json();
  if (opening.positions.length) {
    // The archive spec can leave a seeded position. Use the real bounded unwind, never a
    // ledger reset or a bypass of the one-position-per-asset policy.
    await page
      .getByRole("button", { name: "Emergency stop", exact: true })
      .click();
    for (let attempts = 0; attempts < 6; attempts++) {
      await page
        .getByRole("button", { name: "Refresh HSKSwap data", exact: true })
        .click();
      if (
        !(await (await page.request.get("/api/aegis/state")).json()).positions
          .length
      )
        break;
    }
  }
  // The suite shares one ledger: an earlier spec may have left its emergency stop latched.
  const clear = page.getByRole("button", { name: "Review and clear stop" });
  await page.waitForTimeout(500);
  if (await clear.isVisible()) {
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(clear).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Open trading assistant" }).click();
  await expect(page.locator(".chat-welcome")).toContainText("New to trading");
  const replies = page.locator(".aegis-assistant .chat-message.assistant");
  await page
    .getByRole("button", { name: "What should I do next?", exact: true })
    .click();
  await expect(replies.last()).toContainText("You could say");
  await expect(page.locator(".chat-welcome")).toHaveCount(0);
  await page
    .getByRole("button", { name: "How does this work?", exact: true })
    .click();
  await expect(replies.last()).toContainText("HashKey Chain");
  // Other specs share this fixture ledger. Honour their real entry cooldown rather than
  // assuming this workflow starts with a fresh account or bypassing the risk check.
  const initial = await (await page.request.get("/api/aegis/state")).json();
  const lastFill = initial.fills[0];
  if (lastFill)
    await expect
      .poll(() => Date.now() / 1000 - lastFill.created_at, {
        timeout: 35000,
        message: "Wait for the preserved entry cooldown",
      })
      .toBeGreaterThanOrEqual(31);
  const fillsBefore = (
    await (await page.request.get("/api/aegis/state")).json()
  ).fills.length;
  await page.getByLabel("Message AEGIS").fill("Buy 1 USDT of WHSK");
  await page
    .getByRole("button", { name: "Send to AEGIS", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Review paper buy of WHSK/ });
  await expect(dialog).toContainText("You spend");
  await expect(dialog).toContainText("Virtual funds");
  await page.screenshot({ path: "artifacts/assistant-trade-review.png" });
  // Cancelling changes nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  let state = await (await page.request.get("/api/aegis/state")).json();
  expect(state.fills.length).toBe(fillsBefore);
  await page.getByRole("button", { name: "Open trading assistant" }).click();
  await page.getByLabel("Message AEGIS").fill("Buy 1 USDT of WHSK");
  await page
    .getByRole("button", { name: "Send to AEGIS", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Confirm buy" }).click();
  await expect(page.getByRole("status")).toContainText("Bought WHSK");
  state = await (await page.request.get("/api/aegis/state")).json();
  expect(state.fills.length).toBe(fillsBefore + 1);
  expect(state.paused).toBe(true);
  // The whole round trip works from chat, and the session records it.
  await page.getByRole("button", { name: "Open trading assistant" }).click();
  await page.getByLabel("Message AEGIS").fill("Sell WHSK");
  await page
    .getByRole("button", { name: "Send to AEGIS", exact: true })
    .click();
  const sale = page.getByRole("dialog", { name: /Review paper sell of WHSK/ });
  await expect(sale).toContainText("Estimated result");
  await sale.getByRole("button", { name: "Confirm sell" }).click();
  await expect(page.getByRole("status")).toContainText("Sold WHSK");
  state = await (await page.request.get("/api/aegis/state")).json();
  expect(state.positions).toEqual([]);
  const sessions = await (await page.request.get("/api/aegis/sessions")).json();
  expect(sessions.items[0].trades).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Open trading assistant" }).click();
  await page.getByLabel("Message AEGIS").fill("Analyze my past sessions");
  await page
    .getByRole("button", { name: "Send to AEGIS", exact: true })
    .click();
  await expect(replies.last()).toContainText("closed trade");
  expect(errors).toEqual([]);
});
