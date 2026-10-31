import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { MemoryTenantStore } from "../../src/storage/tenant-store.js";
import { MiniMaxProvider } from "../../src/integrations/llm/minimax.provider.js";
import { TokenUsageService } from "../../src/integrations/llm/token-usage.service.js";
import { createPlatform } from "../../src/server.js";
import { alice, bob, config, spec, FixtureRuntime } from "./helpers.js";
import type {
  LLMProvider,
  LLMRequest,
} from "../../src/integrations/llm/llm.interface.js";

test("Bedrock calls use one configured client, ignore reasoning, account tokens, retain unknown charges", async () => {
  const store = new MemoryTenantStore(),
    usage = new TokenUsageService(store, config);
  const sent: unknown[] = [];
  const client = {
    send: async (c: { input: unknown }) => {
      sent.push(c.input);
      return {
        output: {
          message: {
            content: [
              {
                reasoningContent: {
                  reasoningText: { text: "private reasoning" },
                },
              },
              { text: "Public rationale" },
            ],
          },
        },
        usage: { inputTokens: 12, outputTokens: 4 },
        stopReason: "end_turn",
      };
    },
  } as unknown as BedrockRuntimeClient;
  const provider = new MiniMaxProvider(client, config, usage),
    request: LLMRequest = {
      context: {
        userId: alice.userId,
        sessionId: randomUUID(),
        requestId: randomUUID(),
      },
      system: "trusted",
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    };
  const response = await provider.converse(request);
  assert.deepEqual(response.message.content, [{ text: "Public rationale" }]);
  assert.equal(
    (sent[0] as { modelId: string }).modelId,
    "minimax.minimax-m2.5",
  );
  const row = await store.get<{ tokens: number; reserved: number }>(
    alice,
    "USAGE",
    new Date().toISOString().slice(0, 10),
  );
  assert.equal(row?.data.tokens, 16);
  assert.equal(row?.data.reserved, 0);
  assert.deepEqual((await store.list(bob, "LLM_REQUEST")).items, []);
  const unavailable = new MiniMaxProvider(
    {
      send: async () => {
        throw Error("secret exception trace");
      },
    } as unknown as BedrockRuntimeClient,
    config,
    usage,
  );
  await assert.rejects(unavailable.converse(request), /Bedrock request failed/);
  assert.ok(
    (await store.get<{ reserved: number }>(
      alice,
      "USAGE",
      new Date().toISOString().slice(0, 10),
    ))!.data.reserved > 0,
  );
  const small = new TokenUsageService(store, {
    ...config,
    KRONO_DAILY_TOKEN_LIMIT: 1,
  });
  await assert.rejects(small.reserve(request.context, 20), /budget/);
});

test("Conversation builds a persisted draft with typed tools; profile context survives sessions; no fake deployment", async () => {
  const store = new MemoryTenantStore(),
    runtime = new FixtureRuntime();
  const seen: LLMRequest[] = [];
  const llm: LLMProvider = {
    converse: async (request) => {
      seen.push(request);
      const hasResult = request.messages.some((m) =>
        m.content.some((c) => "toolResult" in c),
      );
      return {
        message: {
          role: "assistant",
          content: hasResult
            ? [
                {
                  text: "Your conservative draft is saved. Review its simulation configuration before deployment.",
                },
              ]
            : [
                {
                  toolUse: {
                    toolUseId: "create1",
                    name: "create_agent_draft",
                    input: spec(),
                  },
                },
              ],
        },
        modelId: config.BEDROCK_MODEL_ID,
        stopReason: hasResult ? "end_turn" : "tool_use",
        durationMs: 1,
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };
  const { app, conversations, profiles } = createPlatform(config, {
    store,
    runtime,
    llm,
    auth: { authenticate: async () => alice },
  });
  try {
    const profile = await profiles.get(alice);
    await profiles.update(
      alice,
      {
        ...profile.data,
        displayName: "Known trader",
        tradingProfile: {
          ...profile.data.tradingProfile,
          preferredAssets: ["BTC"],
        },
      },
      profile.version,
    );
    const chat = await conversations.create(alice),
      rid = randomUUID();
    const result = await conversations.send(
      alice,
      chat.id,
      "Create a conservative momentum agent",
      rid,
    );
    assert.equal(result.status, "COMPLETED");
    assert.equal((await store.list(alice, "AGENT")).items.length, 1);
    assert.equal(runtime.calls.length, 0);
    assert.equal(
      (await conversations.send(alice, chat.id, "same request", rid)).status,
      "COMPLETED",
    );
    assert.equal((await store.list(alice, "AGENT")).items.length, 1);
    await assert.rejects(
      conversations.send(bob, chat.id, "steal", randomUUID()),
      /not found/,
    );
    const next = await conversations.create(alice);
    await conversations.send(
      alice,
      next.id,
      "Recall my preferences",
      randomUUID(),
    );
    assert.match(seen.at(-1)!.system, /Known trader/);
    assert.match(seen.at(-1)!.system, /preferredAssets/);
    assert.equal((await store.list(bob, "CONVERSATION")).items.length, 0);
  } finally {
    await app.close();
  }
});
