import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

mkdirSync(".runtime", { recursive: true });
const directory = mkdtempSync(resolve(".runtime/e2e-"));
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
  },
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 1));
