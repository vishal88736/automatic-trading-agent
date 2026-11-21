import { spawn } from "node:child_process";

const uiPort = process.env.KRONO_E2E_UI_PORT ?? "5180";
const gatewayPort = process.env.KRONO_E2E_GATEWAY_PORT ?? "8793";
const platform = spawn(
  "node",
  ["--import", "tsx", "tests/e2e/platform-server.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TERMINAL_TEST_RUN: "1",
      NODE_ENV: "test",
      AWS_EC2_METADATA_DISABLED: "true",
      KRONO_E2E_GATEWAY_PORT: gatewayPort,
      KRONO_E2E_PUBLIC_ORIGIN: `http://127.0.0.1:${uiPort}`,
    },
  },
);
const vite = spawn(
  "node_modules/.bin/vite",
  [
    ...(process.env.KRONO_E2E_BUILD === "1" ? ["preview"] : []),
    "--config",
    "frontend/vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    uiPort,
    "--strictPort",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      KRONO_PLATFORM_URL: `http://127.0.0.1:${gatewayPort}`,
    },
  },
);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    vite.kill(signal);
    platform.kill(signal);
  });
}

platform.on("exit", (code) => {
  vite.kill("SIGTERM");
  process.exit(code ?? 1);
});
vite.on("exit", (code) => {
  platform.kill("SIGTERM");
  process.exit(code ?? 1);
});
