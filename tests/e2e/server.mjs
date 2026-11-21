import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

mkdirSync(".runtime", { recursive: true });
const directory = mkdtempSync(resolve(".runtime/e2e-"));
const uiPort = process.env.TERMINAL_UI_PORT ?? "5179";
const apiPort = process.env.TERMINAL_PORT ?? "8791";
const gatewayPort = process.env.KRONO_E2E_GATEWAY_PORT ?? "8792";
const platform = spawn("node", ["--import", "tsx", "e2e/platform-server.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    TERMINAL_TEST_RUN: "1",
    NODE_ENV: "test",
    AWS_EC2_METADATA_DISABLED: "true",
    KRONO_E2E_PUBLIC_ORIGIN: `http://127.0.0.1:${uiPort}`,
  },
});
const child = spawn("node", ["scripts/dev.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    TERMINAL_TEST_RUN: "1",
    TERMINAL_QUIET_LOGS: "true",
    TERMINAL_MODE: "SIMULATION",
    TERMINAL_DB: resolve(directory, "simulation.sqlite3"),
    MARKET_PROVIDER: "fixture",
    NEWS_PROVIDER: "fixture",
    RESEARCH_ENABLED: "false",
    NEWS_API_KEY: "",
    TERMINAL_API_TOKEN: "",
    TERMINAL_PORT: apiPort,
    TERMINAL_UI_PORT: uiPort,
    VITE_KRONO_LEGACY_FIXTURES: "true",
    TERMINAL_BACKEND_URL: `http://127.0.0.1:${apiPort}`,
    KRONO_PLATFORM_URL: `http://127.0.0.1:${gatewayPort}`,
  },
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
  platform.kill("SIGTERM");
});
process.on("SIGINT", () => {
  child.kill("SIGINT");
  platform.kill("SIGINT");
});
platform.on("exit", (code) => {
  child.kill("SIGTERM");
  process.exit(code ?? 1);
});
child.on("exit", (code) => {
  platform.kill("SIGTERM");
  process.exit(code ?? 1);
});
