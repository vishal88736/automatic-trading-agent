import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

mkdirSync(".runtime", { recursive: true });
const directory = mkdtempSync(resolve(".runtime/e2e-"));
const platform = spawn("node", ["--import", "tsx", "e2e/platform-server.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    TERMINAL_TEST_RUN: "1",
    NODE_ENV: "test",
    AWS_EC2_METADATA_DISABLED: "true",
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
    TERMINAL_PORT: "8791",
    TERMINAL_UI_PORT: "5179",
    TERMINAL_BACKEND_URL: "http://127.0.0.1:8791",
    KRONO_PLATFORM_URL: "http://127.0.0.1:8792",
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
