// Isolated UI contract harness. Never selected by the production entry point.
import { createPlatform } from "../../backend/gateway/server.js";
import { MemoryTenantStore } from "../../backend/gateway/storage/tenant-store.js";
import {
  config,
  FixtureRuntime,
} from "../../backend/tests/platform/helpers.js";
import { PlatformError } from "../../backend/gateway/domain/errors.js";
import { RulesProvider } from "../../backend/gateway/integrations/llm/rules.provider.js";
import type { LLMProvider } from "../../backend/gateway/integrations/llm/llm.interface.js";
if (process.env.TERMINAL_TEST_RUN !== "1")
  throw Error("This server is restricted to browser fixture validation");

// A restarted fixture gateway must reopen the same test accounts.
const users = {
  alice: { userId: "00000000-0000-4000-8000-000000000001", username: "alice" },
  bob: { userId: "00000000-0000-4000-8000-000000000002", username: "bob" },
  lifecycle: {
    userId: "00000000-0000-4000-8000-000000000003",
    username: "lifecycle",
  },
};
function knownUser(name: string): name is keyof typeof users {
  return Object.hasOwn(users, name);
}

const store = new MemoryTenantStore();
const auth = {
  authenticate: async (req: {
    cookies: Record<string, string>;
    method: string;
    headers: Record<string, unknown>;
  }) => {
    const user = req.cookies.krono_fixture;
    if (!knownUser(user))
      throw new PlatformError(
        "UNAUTHENTICATED",
        "Fixture sign in required",
        401,
      );
    if (req.method !== "GET" && req.headers["x-krono-csrf"] !== "fixture-csrf")
      throw new PlatformError("CSRF", "Fixture CSRF required", 403);
    return users[user];
  },
};
const rules = new RulesProvider();
const llm: LLMProvider = {
  converse: async (request) => {
    if (request.outputSchema?.name === "paper_market_insight") {
      const input = request.messages[0]?.content[0];
      if (!input || !("text" in input))
        throw new Error("Missing market evidence");
      const evidence = JSON.parse(input.text);
      if (
        !evidence.market.candles.length ||
        !evidence.headlines.some(
          (item: { scope: string }) => item.scope === "asset",
        )
      )
        throw new Error(
          "Chart data and asset headlines are required for fixture insight",
        );
      return {
        message: {
          role: "assistant",
          content: [
            {
              text: JSON.stringify({
                summary: "BTC chart and news at a glance.",
                observations: [
                  "Momentum and volatility indicators were available.",
                ],
                news_analysis: ["Headlines provide context for the chart."],
                uncertainty: "This snapshot cannot establish future returns.",
              }),
            },
          ],
        },
        modelId: "FIXTURE",
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: 0,
        stopReason: "end_turn",
      };
    }
    if (request.outputSchema?.name === "paper_strategy_draft") {
      return rules.converse(request);
    }
    throw new Error("Unexpected model request in the product browser fixture");
  },
};
const { app } = createPlatform(
  {
    ...config,
    KRONO_PUBLIC_ORIGIN:
      process.env.KRONO_E2E_PUBLIC_ORIGIN ?? "http://127.0.0.1:5179",
    KRONO_PRODUCT_API_URL: process.env.KRONO_E2E_PRODUCT_API_URL,
    KRONO_PRODUCT_API_KEY: process.env.KRONO_E2E_PRODUCT_API_KEY,
  },
  { store, runtime: new FixtureRuntime(), auth, llm },
);
app.post("/platform/auth/login", async (req, reply) => {
  const input = req.body as { email?: unknown; password?: unknown } | null;
  const email = typeof input?.email === "string" ? input.email : "";
  const username = email.split("@")[0];
  if (
    !knownUser(username) ||
    email !== `${username}@fixture.test` ||
    input?.password !== "fixture"
  )
    throw new PlatformError("UNAUTHENTICATED", "Fixture sign in required", 401);
  reply.setCookie("krono_fixture", username, {
    path: "/platform",
    httpOnly: true,
    sameSite: "strict",
  });
  return { authenticated: true, csrf: "fixture-csrf" };
});
app.get("/platform/auth/session", async (req) => {
  const p = await auth.authenticate(req as never);
  return {
    ...p,
    email: `${p.username}@fixture.test`,
    csrf: "fixture-csrf",
  };
});
app.post("/platform/auth/logout", async (req, reply) => {
  await auth.authenticate(req as never);
  reply.clearCookie("krono_fixture", { path: "/platform" });
  return { signedOut: true };
});
await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.KRONO_E2E_GATEWAY_PORT ?? 8792),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
