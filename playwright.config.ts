import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const baseURL = `http://127.0.0.1:${process.env.KRONO_E2E_UI_PORT ?? "5180"}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  outputDir: "artifacts/browser-tests",
  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    viewport: { width: 1512, height: 982 },
    colorScheme: "dark",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
        (!process.env.CI && existsSync("/usr/bin/chromium")
          ? "/usr/bin/chromium"
          : undefined),
    },
  },
  webServer: {
    command: "node tests/e2e/server.mjs",
    url: `${baseURL}/platform/health`,
    timeout: 30000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  },
});
