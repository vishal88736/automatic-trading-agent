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
