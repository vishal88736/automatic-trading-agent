// One command for the whole local stack: PostgreSQL, migrations, product API, paper worker,
// gateway with self-hosted sign-in, and the Vite UI. Secrets are generated once and kept in
// .runtime/dev.json (ignored by Git). Set KRONO_DATABASE_DSN to use your own PostgreSQL.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

if (existsSync(".env")) process.loadEnvFile(".env");
// Blank lines copied from .env.example mean "use the default", not an empty value.
for (const [name, value] of Object.entries(process.env))
  if (value === "") delete process.env[name];
const python = ".venv/bin/python";
if (!existsSync(python)) {
  console.error("Run `make setup` first to create the Python environment.");
  process.exit(1);
}

const ports = {
  ui: Number(process.env.TERMINAL_UI_PORT ?? 5173),
  gateway: Number(process.env.KRONO_PORT ?? 8790),
  api: Number(process.env.KRONO_PRODUCT_API_PORT ?? 8794),
  db: Number(process.env.KRONO_DEV_DB_PORT ?? 55432),
};

async function free(port) {
  return new Promise((resolve) => {
    const probe = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => probe.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}
for (const [name, port] of Object.entries(ports).filter(([n]) => n !== "db"))
  if (!(await free(port))) {
    console.error(
      `Port ${port} (${name}) is already in use. Stop the other Krono stack (or that process) and retry.`,
    );
    process.exit(1);
  }

mkdirSync(".runtime", { recursive: true, mode: 0o700 });
const secretsFile = ".runtime/dev.json";
const secrets = existsSync(secretsFile)
  ? JSON.parse(readFileSync(secretsFile, "utf8"))
  : {
      productKey: randomBytes(32).toString("hex"),
      sessionSecret: randomBytes(32).toString("hex"),
      dbPassword: randomBytes(16).toString("hex"),
    };
// Added after the first release of this file, so older .runtime/dev.json files gain it too.
secrets.credentialKey ??= randomBytes(32).toString("hex");
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });

const log = (message) => console.log(`\x1b[36m[krono]\x1b[0m ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function docker(...args) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

async function database() {
  if (process.env.KRONO_DATABASE_DSN) return process.env.KRONO_DATABASE_DSN;
  const name = "krono-dev-postgres";
  const state = docker("inspect", "-f", "{{.State.Running}}", name);
  if (state.status !== 0) {
    log("Starting PostgreSQL in Docker (first run only creates it)…");
    const created = docker(
      "run",
      "-d",
      "--name",
      name,
      "--restart",
      "unless-stopped",
      "-e",
      "POSTGRES_USER=krono",
      "-e",
      "POSTGRES_DB=krono",
      "-e",
      `POSTGRES_PASSWORD=${secrets.dbPassword}`,
      "-p",
      `127.0.0.1:${ports.db}:5432`,
      "-v",
      "krono-dev-pgdata:/var/lib/postgresql/data",
      process.env.KRONO_DEV_POSTGRES_IMAGE ?? "postgres:17",
    );
    if (created.status !== 0) {
      console.error(created.stderr || "Docker could not start PostgreSQL.");
      console.error("Install Docker or set KRONO_DATABASE_DSN.");
      process.exit(1);
    }
  } else if (state.stdout.trim() !== "true") {
    docker("start", name);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      docker("exec", name, "pg_isready", "-U", "krono", "-d", "krono")
        .status === 0
    )
      return `postgresql://krono:${secrets.dbPassword}@127.0.0.1:${ports.db}/krono`;
    await sleep(500);
  }
  console.error("PostgreSQL did not become ready.");
  process.exit(1);
}

const dsn = await database();
const env = {
  ...process.env,
  KRONO_DATABASE_DSN: dsn,
  KRONO_PRODUCT_API_KEY: secrets.productKey,
  KRONO_CREDENTIAL_KEY:
    process.env.KRONO_CREDENTIAL_KEY ?? secrets.credentialKey,
};
log("Applying database migrations…");
const migrated = spawnSync(python, ["-m", "scripts.platform_database"], {
  env,
  stdio: "inherit",
});
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

const model = process.env.GROQ_API_KEY ? "groq" : "rules";
const gatewayEnv = {
  ...env,
  NODE_ENV: "development",
  KRONO_AUTH_MODE: process.env.KRONO_AUTH_MODE ?? "local",
  KRONO_SESSION_SECRET:
    process.env.KRONO_SESSION_SECRET ?? secrets.sessionSecret,
  KRONO_PORT: String(ports.gateway),
  KRONO_PUBLIC_ORIGIN: `http://127.0.0.1:${ports.ui}`,
  KRONO_PRODUCT_API_URL: `http://127.0.0.1:${ports.api}`,
  KRONO_LLM_PROVIDER: process.env.KRONO_LLM_PROVIDER ?? model,
};

const colors = { api: 33, worker: 35, gateway: 34, ui: 32 };
const children = [];
function run(name, command, args, childEnv) {
  const child = spawn(command, args, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `\x1b[${colors[name]}m[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n"))
        if (line.trim()) out.write(prefix + line + "\n");
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!stopping) {
      log(`${name} exited (${code}); stopping the stack.`);
      stop(code ?? 1);
    }
  });
  children.push(child);
}

run(
  "api",
  python,
  [
    "-m",
    "uvicorn",
    "backend.product.api:app_from_environment",
    "--factory",
    "--host",
    "127.0.0.1",
    "--port",
    String(ports.api),
  ],
  env,
);
run("worker", python, ["-m", "backend.product.worker"], env);
run(
  "gateway",
  "node",
  ["--import", "tsx", "backend/gateway/server.ts"],
  gatewayEnv,
);
run(
  "ui",
  "node_modules/.bin/vite",
  ["--config", "frontend/vite.config.ts", "--host", "127.0.0.1"],
  {
    ...process.env,
    TERMINAL_UI_PORT: String(ports.ui),
    KRONO_PLATFORM_URL: `http://127.0.0.1:${ports.gateway}`,
  },
);
log(
  `Krono is starting at http://127.0.0.1:${ports.ui}/  (sign-in: ${gatewayEnv.KRONO_AUTH_MODE}, strategy chat: ${gatewayEnv.KRONO_LLM_PROVIDER})`,
);
log(
  "Agents run in the worker, not the browser: closing the tab never stops them. Stopping this command pauses them until the worker restarts from its checkpoint.",
);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 800).unref();
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
