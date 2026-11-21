// Isolated UI contract harness. Never selected by the production entry point.
import { createPlatform } from "../backend/src/server.js";
import { MemoryTenantStore } from "../backend/src/storage/tenant-store.js";
import {
  alice,
  bob,
  config,
  spec,
  FixtureRuntime,
} from "../backend/tests/platform/helpers.js";
import { PlatformError } from "../backend/src/domain/errors.js";
import type { LLMProvider } from "../backend/src/integrations/llm/llm.interface.js";
if (process.env.TERMINAL_TEST_RUN !== "1")
  throw Error("This server is restricted to browser fixture validation");
class BrowserRuntime extends FixtureRuntime {
  async deploy(
    p: typeof alice,
    a: Parameters<FixtureRuntime["deploy"]>[1],
    d: Parameters<FixtureRuntime["deploy"]>[2],
  ) {
    const r = await super.deploy(p, a, d);
    this.statuses.set(a.id, "RUNNING");
    return r;
  }
}
const runtime = new BrowserRuntime(),
  store = new MemoryTenantStore();
const auth = {
  authenticate: async (req: {
    cookies: Record<string, string>;
    method: string;
    headers: Record<string, unknown>;
  }) => {
    const user = req.cookies.krono_fixture;
    if (!["alice", "bob"].includes(user))
      throw new PlatformError(
        "UNAUTHENTICATED",
        "Fixture sign in required",
        401,
      );
    if (req.method !== "GET" && req.headers["x-krono-csrf"] !== "fixture-csrf")
      throw new PlatformError("CSRF", "Fixture CSRF required", 403);
    return user === "alice" ? alice : bob;
  },
};
const llm: LLMProvider = {
  converse: async (request) => {
    if (request.outputSchema?.name === "paper_market_insight") {
      return {
        message: {
          role: "assistant",
          content: [
            {
              text: JSON.stringify({
                observations:
                  "The fixture combines momentum and volatility indicators.",
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
      const input = request.messages[0]?.content[0];
      const prompt = input && "text" in input ? input.text : "";
      const tradeEveryBar = prompt.includes("BTC price is above 1 USD");
      const strategy = {
        name: tradeEveryBar ? "Fixture price draft" : "Fixture RSI draft",
        definition: {
          asset: "BTC",
          entry: {
            conditions: [
              tradeEveryBar
                ? { indicator: "price", operator: "gt", threshold: "1" }
                : { indicator: "rsi", operator: "lt", threshold: "30" },
            ],
          },
          exit: {
            conditions: [
              tradeEveryBar
                ? { indicator: "price", operator: "gt", threshold: "1" }
                : { indicator: "rsi", operator: "gt", threshold: "65" },
            ],
          },
          cash_fraction:
            prompt.includes("current_document") && prompt.includes("Use 3%")
              ? "0.03"
              : "0.02",
          stop_loss: "0.04",
        },
      };
      return {
        message: {
          role: "assistant",
          content: [
            {
              text: JSON.stringify({
                strategy_json: JSON.stringify(strategy),
                notes: "Fixture draft for review",
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
    const done = request.messages
      .at(-1)
      ?.content.some((c) => "toolResult" in c);
    return {
      message: {
        role: "assistant",
        content: done
          ? [
              {
                text: "Your validated draft is saved in the isolated test fixture. Review its configuration before a fixture deployment.",
              },
            ]
          : [
              {
                toolUse: {
                  toolUseId: "fixture-create",
                  name: "create_agent_draft",
                  input: spec({ name: "Browser fixture operator" }),
                },
              },
            ],
      },
      modelId: "FIXTURE — no Bedrock call",
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: 0,
      stopReason: done ? "end_turn" : "tool_use",
    };
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
  { store, runtime, auth, llm },
);
app.post("/platform/auth/login", async (req, reply) => {
  const v = req.body as { email: string };
  const username = v.email === "bob@fixture.test" ? "bob" : "alice";
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
    email: p === alice ? "alice@fixture.test" : "bob@fixture.test",
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
