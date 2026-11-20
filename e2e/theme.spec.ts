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

test("the home orbit rotates, respects reduced motion, and leaves the desk action available", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const rotor = page.locator(".orbit-rotor");
  await expect(rotor).toHaveCSS("animation-name", "orbit-turn");
  await page.getByRole("button", { name: "Pause orbit animation" }).click();
  await expect(rotor).toHaveCSS("animation-play-state", "paused");
  await page.getByRole("button", { name: "Play orbit animation" }).click();
  await expect(rotor).toHaveCSS("animation-play-state", "running");
  const turns = await rotor.evaluate(async (node) => {
    const [orbit] = node.getAnimations();
    orbit.pause();
    await orbit.ready;
    orbit.currentTime = 0;
    const start = getComputedStyle(node).transform;
    orbit.currentTime = 11500;
    return start !== getComputedStyle(node).transform;
  });
  expect(turns).toBe(true);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(rotor).toHaveCSS("animation-name", "none");
  await expect(
    page.getByRole("button", { name: "Pause orbit animation" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Open trading desk" }).click();
  await expect(
    page.getByRole("heading", { name: "Trading desk", exact: true }),
  ).toBeVisible();
});

test("the unified landing fits the full ring and opens a separate sign-in screen", async ({
  page,
}) => {
  await page.route("**/platform/health", (route) =>
    route.fulfill({ json: { productConfigured: true } }),
  );
  await page.route("**/platform/auth/session", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/platform/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/workspace#/dashboard");
  const hero = page.getByRole("heading", {
    name: "Trade with Krono.",
    exact: true,
  });
  await expect(hero).toBeVisible();

  for (const [width, height] of [
    [1502, 726],
    [1366, 600],
    [390, 844],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    const bounds = await page.evaluate(() => {
      const workspace = document
        .querySelector(".unified-workspace .workspace")!
        .getBoundingClientRect();
      const { left, top, right, bottom } = document
        .querySelector(".orbit-plane")!
        .getBoundingClientRect();
      return {
        left,
        top,
        right,
        bottom,
        workspaceLeft: workspace.left,
        workspaceRight: workspace.right,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(bounds.workspaceLeft).toBe(0);
    expect(bounds.workspaceRight).toBe(width);
    expect(bounds.scrollWidth).toBe(width);
    expect(bounds.left).toBeGreaterThan(0);
    expect(bounds.right).toBeLessThan(width);
    expect(bounds.top).toBeGreaterThan(0);
    expect(bounds.bottom).toBeLessThan(height);
  }
  const coins = page.locator(".orbit-satellite");
  await expect(coins).toHaveCount(3);
  const moved = await coins.first().evaluate(async (coin) => {
    const [motion] = coin.getAnimations();
    motion.pause();
    await motion.ready;
    motion.currentTime = 0;
    const initial = coin.getBoundingClientRect();
    motion.currentTime = 6000;
    const latest = coin.getBoundingClientRect();
    return Math.hypot(latest.x - initial.x, latest.y - initial.y) > 10;
  });
  expect(moved).toBe(true);
  await page.getByRole("button", { name: "Pause orbit animation" }).click();
  await expect(coins.last()).toHaveCSS("animation-play-state", "paused");
  await expect(coins.last().locator(".coin")).toHaveCSS(
    "animation-play-state",
    "paused",
  );
  await page.getByRole("button", { name: "Play orbit animation" }).click();
  await expect(coins.last()).toHaveCSS("animation-play-state", "running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(coins.last()).toHaveCSS("animation-name", "none");
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page).toHaveURL(/#\/sign-in$/);
  await expect(
    page.getByRole("heading", { name: "Welcome to your workspace" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  await expect(hero).toHaveCount(0);
  await expect(page.locator(".home-orbit")).toHaveCount(0);
  await page.goBack();
  await expect(hero).toBeVisible();
});
