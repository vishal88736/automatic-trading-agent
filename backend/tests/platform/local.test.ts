import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { loadConfig } from "../../gateway/config.js";
import { LocalAuth } from "../../gateway/auth/local.js";
import {
  SERVICE_SUBJECT,
  type ProductForward,
} from "../../gateway/product/client.js";
import {
  draftStrategy,
  RulesProvider,
} from "../../gateway/integrations/llm/rules.provider.js";
import { config } from "./helpers.js";

test("local mode starts without AWS settings but still requires the product API", () => {
  const base = {
    KRONO_AUTH_MODE: "local",
    KRONO_PRODUCT_API_URL: "http://127.0.0.1:8794",
    KRONO_PRODUCT_API_KEY: "k".repeat(32),
  };
  const local = loadConfig(base);
  assert.equal(local.KRONO_AUTH_MODE, "local");
  assert.throws(() => loadConfig({ KRONO_AUTH_MODE: "local" }), /product API/);
  assert.throws(() => loadConfig({}), /COGNITO_USER_POOL_ID/);
  assert.throws(
    () =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        KRONO_PUBLIC_ORIGIN: "https://krono.example",
        KRONO_PRODUCT_API_URL: "https://api.krono.example",
      }),
    /KRONO_SESSION_SECRET/,
  );
});

test("local sign-in issues signed sessions, enforces CSRF and rejects forged cookies", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const calls: Array<[string, string, string]> = [];
  const forward: ProductForward = async (subject, method, path) => {
    calls.push([subject, method, path]);
    const user = { id: userId, email: "a@example.com", display_name: "Ana" };
    if (path === "/platform/internal/sessions") return Response.json({ user });
    if (path === "/platform/internal/users")
      return Response.json({ error: { message: "exists" } }, { status: 409 });
    if (path === `/platform/internal/users/${userId}`)
      return Response.json({ user });
    return Response.json({}, { status: 404 });
  };
  const auth = new LocalAuth(
    {
      ...config,
      KRONO_AUTH_MODE: "local",
      KRONO_SESSION_SECRET: "s".repeat(32),
    },
    forward,
  );
  const app = Fastify();
  await app.register(cookie);
  auth.routes(app);
  app.post("/platform/protected", async (req) => auth.authenticate(req));

  const login = await app.inject({
    method: "POST",
    url: "/platform/auth/login",
    payload: { email: "a@example.com", password: "whatever" },
  });
  assert.equal(login.statusCode, 200);
  assert.ok(calls.every(([subject]) => subject === SERVICE_SUBJECT));
  const jar = Object.fromEntries(login.cookies.map((c) => [c.name, c.value]));
  assert.ok(jar.krono_session && jar.krono_csrf);
  assert.ok(login.cookies.every((c) => c.httpOnly && c.sameSite === "Strict"));

  const session = await app.inject({
    method: "GET",
    url: "/platform/auth/session",
    cookies: jar,
  });
  assert.equal(session.json().displayName, "Ana");

  const noCsrf = await app.inject({
    method: "POST",
    url: "/platform/protected",
    cookies: jar,
  });
  assert.equal(noCsrf.statusCode, 403);
  const ok = await app.inject({
    method: "POST",
    url: "/platform/protected",
    cookies: jar,
    headers: { "x-krono-csrf": jar.krono_csrf },
  });
  assert.equal(ok.json().userId, userId);

  const [id, expires] = jar.krono_session!.split(".");
  const forged = `${id!.replace(/^1/, "2")}.${expires}.${jar.krono_session!.split(".")[2]}`;
  const rejected = await app.inject({
    method: "GET",
    url: "/platform/auth/session",
    cookies: { ...jar, krono_session: forged },
  });
  assert.equal(rejected.statusCode, 401);

  const duplicate = await app.inject({
    method: "POST",
    url: "/platform/auth/register",
    payload: {
      email: "a@example.com",
      password: "long password",
      displayName: "A",
    },
  });
  assert.equal(duplicate.statusCode, 409);
});

test("the rules drafter turns plain English into a valid strategy and revises it", () => {
  const first = draftStrategy(
    "Buy ETH when RSI drops below 28 and sell when RSI is above 68, use 5% per trade, 3% stop loss, take profit 6%",
  );
  assert.ok(first.strategy);
  const d = first.strategy.definition;
  assert.equal(d.asset, "ETH");
  assert.deepEqual(d.entry.conditions, [
    { indicator: "rsi", operator: "lt", threshold: "28" },
  ]);
  assert.deepEqual(d.exit.conditions, [
    { indicator: "rsi", operator: "gt", threshold: "68" },
  ]);
  assert.equal(d.cash_fraction, "0.05");
  assert.equal(d.stop_loss, "0.03");
  assert.equal(d.take_profit, "0.06");

  const revised = draftStrategy(
    "switch to SOL and use 3% per trade",
    first.strategy,
  );
  assert.equal(revised.strategy?.definition.asset, "SOL");
  assert.equal(revised.strategy?.definition.cash_fraction, "0.03");
  assert.equal(revised.strategy?.definition.stop_loss, "0.03");
  assert.deepEqual(revised.strategy?.definition.entry, d.entry);
  assert.equal(revised.strategy?.name, "SOL RSI mean reversion");

  assert.equal(draftStrategy("what's the weather").strategy, null);

  const ada = draftStrategy("Buy ada when RSI drops below 30", undefined, [
    "BTC",
    "ADA",
  ]);
  assert.equal(ada.strategy?.definition.asset, "ADA");
  assert.equal(
    draftStrategy("Buy UNKNOWN when RSI drops below 30", undefined, [
      "BTC",
      "ADA",
    ]).strategy,
    null,
  );

  // The exit level is found even when a number sits between "RSI" and "above".
  const plain = draftStrategy(
    "Buy ETH when RSI drops below 30 and sell when it goes above 65",
  );
  assert.deepEqual(plain.strategy?.definition.exit.conditions, [
    { indicator: "rsi", operator: "gt", threshold: "65" },
  ]);
});

test("the rules provider answers the strategy draft schema with explanatory notes", async () => {
  const response = await new RulesProvider().converse({
    context: { userId: "u", sessionId: "s", requestId: "r" },
    system: "",
    messages: [{ role: "user", content: [{ text: "MACD crossover on BTC" }] }],
    outputSchema: { name: "paper_strategy_draft", schema: {} },
  });
  const block = response.message.content[0];
  assert.ok(block && "text" in block);
  const output = JSON.parse(block.text) as {
    strategy_json: string;
    notes: string;
  };
  assert.match(output.notes, /MACD crossover/);
  assert.equal(
    JSON.parse(output.strategy_json).definition.entry.conditions[0].operator,
    "crosses_above",
  );
});
