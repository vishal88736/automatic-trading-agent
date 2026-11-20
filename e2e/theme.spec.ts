import { expect, test, type Page } from "@playwright/test";

async function stubSignedOutSession(page: Page) {
  await page.route("**/platform/health", (route) =>
    route.fulfill({ json: { productConfigured: true } }),
  );
  await page.route("**/platform/auth/session", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/platform/auth/refresh", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
}

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

test("the sapphire landing fits the viewport and opens a separate sign-in screen without WebGL", async ({
  page,
}) => {
  await stubSignedOutSession(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      options?: unknown,
    ) {
      return type === "webgl2"
        ? null
        : Reflect.apply(getContext, this, [type, options]);
    } as typeof getContext;
  });
  const darkPoster = page.waitForResponse("**/art/krono-studio-dark.webp");
  await page.goto("/workspace#/dashboard");
  const hero = page.getByRole("heading", {
    name: "Build and test crypto strategies.",
    exact: true,
  });
  await expect(hero).toBeVisible();
  expect((await darkPoster).ok()).toBe(true);

  const landing = page.locator(".krono-landing");
  const scene = page.locator(".landing-scene");
  const start = page.getByRole("link", { name: "Get started" });
  await expect(landing).toHaveCSS("background-color", "rgb(8, 18, 28)");
  await expect(scene.locator("canvas")).toHaveAttribute("data-ready", "false");
  await expect(page.locator(".landing-motion")).toHaveCount(0);

  for (const [width, height] of [
    [1502, 726],
    [1366, 600],
    [850, 780],
    [390, 844],
    [365, 720],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    const heroBounds = (await page.locator(".landing-hero").boundingBox())!;
    const artBounds = (await scene.boundingBox())!;
    expect(heroBounds.width).toBe(width);
    expect(heroBounds.height).toBeGreaterThanOrEqual(height);
    expect(artBounds.x).toBeGreaterThanOrEqual(0);
    expect(artBounds.x + artBounds.width).toBeLessThanOrEqual(width);
    expect(artBounds.y + artBounds.height).toBeLessThanOrEqual(
      heroBounds.height,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await expect(start).toBeInViewport({ ratio: 1 });
  }
  const lightPoster = page.waitForResponse("**/art/krono-studio-light.webp");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  expect((await lightPoster).ok()).toBe(true);
  await expect(landing).toHaveCSS("background-color", "rgb(238, 244, 248)");
  await expect
    .poll(() =>
      scene.evaluate(
        (node) => getComputedStyle(node, "::before").backgroundImage,
      ),
    )
    .toContain("krono-studio-light.webp");
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await start.click();
  await expect(page).toHaveURL(/#\/sign-in$/);
  await expect(
    page.getByRole("heading", { name: "Welcome to your workspace" }),
  ).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  await expect(hero).toHaveCount(0);
  await expect(scene).toHaveCount(0);
  await page.goBack();
  await expect(hero).toBeVisible();
});

test("landing section links focus the selected content and preserve protected destinations", async ({
  page,
}) => {
  await stubSignedOutSession(page);
  await page.goto("/workspace#/dashboard");
  await page.getByRole("link", { name: "See how it works" }).click();
  await expect(page).toHaveURL(/#\/dashboard\?section=workflow$/);
  const workflow = page.getByRole("region", {
    name: "From strategy to paper trading",
  });
  await expect(workflow).toBeFocused();
  await expect(
    workflow.getByRole("link", { name: /Build your rules/ }),
  ).toHaveAttribute("href", "#/builder");
  await workflow.getByRole("link", { name: /Backtest a strategy/ }).click();
  await expect(page).toHaveURL(/#\/backtests$/);
  await expect(
    page.getByRole("heading", { name: "Welcome to your workspace" }),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);

  await page.goBack();
  await expect(workflow).toBeFocused();
  await page
    .getByRole("navigation", { name: "Krono links" })
    .getByRole("link", { name: "Workspace tools" })
    .click();
  await expect(page).toHaveURL(/#\/dashboard\?section=tools$/);
  await page.reload();
  await expect(page.locator("#landing-tools")).toBeFocused();
  await expect(
    page.getByRole("link", { name: "Ethereum (ETH)" }),
  ).toHaveAttribute("href", "#/markets?asset=ETH");
});

test("the landing coin pauses, resumes, and respects reduced motion", async ({
  playwright,
  baseURL,
}, testInfo) => {
  const options = testInfo.project.use.launchOptions;
  const browser = await playwright.chromium.launch({
    ...options,
    args: [
      ...(options?.args ?? []),
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  try {
    const page = await browser.newPage({
      baseURL,
      viewport: { width: 900, height: 640 },
      colorScheme: "dark",
      reducedMotion: "no-preference",
    });
    await stubSignedOutSession(page);
    await page.goto("/workspace#/dashboard");
    await expect(page.locator(".landing-scene canvas")).toHaveAttribute(
      "data-ready",
      "true",
    );
    const box = (await page.locator(".landing-scene").boundingBox())!;
    const capture = () =>
      page.screenshot({
        clip: {
          x: box.x + 12,
          y: box.y + 12,
          width: box.width - 24,
          height: box.height - 68,
        },
      });
    const nextPaint = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    const pause = page.getByRole("button", { name: "Pause landing animation" });
    const play = page.getByRole("button", { name: "Play landing animation" });
    await pause.click();
    await expect(play).toBeVisible();
    await nextPaint();
    const paused = await capture();
    await nextPaint();
    expect((await capture()).equals(paused)).toBe(true);

    await play.click();
    await expect.poll(async () => (await capture()).equals(paused)).toBe(false);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(pause).toHaveCount(0);
    await nextPaint();
    const reduced = await capture();
    await nextPaint();
    expect((await capture()).equals(reduced)).toBe(true);
  } finally {
    await browser.close();
  }
});
