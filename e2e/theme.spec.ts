import { expect, test } from "@playwright/test";

test("theme follows the system, persists a choice and styles existing workspaces", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Command center", exact: true }),
  ).toBeVisible();
  const root = page.locator("html");
  const background = () =>
    page
      .locator("body")
      .evaluate((body) => getComputedStyle(body).backgroundColor);
  await expect(root).toHaveAttribute("data-theme", "light");
  const light = await background();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(light);
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  expect(await background()).toBe(light);
  await expect(
    page.getByRole("heading", { name: "Market watch", exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/#/aegis");
  await expect(
    page.getByRole("button", { name: "Switch to dark theme" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(321);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: "Emergency stop", exact: true }),
  ).toBeVisible();
});
