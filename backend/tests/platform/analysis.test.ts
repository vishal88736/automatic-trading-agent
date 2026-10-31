import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AgentAnalysisService } from "../../src/integrations/llm/agent-analysis.service.js";
import {
  MemoryTenantStore,
  DynamoTenantStore,
} from "../../src/storage/tenant-store.js";
import { AgentService } from "../../src/agents/agent.service.js";
import { ProfileService } from "../../src/profiles/profile.service.js";
import { bedrockSchema } from "../../src/integrations/llm/structured-output.js";
import { specSchema } from "../../src/domain/schemas.js";
import { alice, bob, config, spec, FixtureRuntime } from "./helpers.js";
import type { LLMProvider } from "../../src/integrations/llm/llm.interface.js";

test("Autonomous model reviews cannot invent evidence, enable an ineligible strategy or escape the source tenant", async () => {
  const store = new MemoryTenantStore(),
    agents = new AgentService(
      store,
      new FixtureRuntime(),
      config,
      new ProfileService(store),
    );
  const a = await agents.create(alice, spec()),
    requestId = randomUUID(),
    updates: unknown[] = [];
  const preview = await agents.preview(alice, a.id);
  const deployed = await agents.deploy(alice, a.id, {
    expectedVersion: preview.version,
    digest: preview.digest,
    acknowledgement: "DEPLOY_SIMULATION",
  });
  const deploymentId = deployed.data.deployment!.id;
  const db = {
    send: async (c: {
      input: Record<string, unknown>;
      constructor: { name: string };
    }) => {
      if (c.constructor.name === "UpdateCommand") {
        updates.push(c.input);
        return {};
      }
      const key = c.input.Key as { pk: string; sk: string };
      assert.equal(key.pk, `TENANT#${alice.userId}#AGENT#${a.id}`);
      return {
        Item:
          key.sk === "CONTROL"
            ? { activeDeployment: deploymentId }
            : {
                deploymentId,
                expiresAt: Date.now() / 1000 + 900,
                data: {
                  symbol: "BTC",
                  marketSource: "synthetic_fixture_v1",
                  marketAsOf: "2026-01-19T22:00:00+00:00",
                  rankings: [
                    { strategy_id: "momentum_v1", eligible: true },
                    { strategy_id: "spread_research_v1", eligible: false },
                  ],
                  evidenceRefs: ["article-one"],
                },
              },
      };
    },
  } as unknown as DynamoDBDocumentClient;
  let preferredStrategy = "spread_research_v1",
    evidenceRefs = ["article-one"];
  const llm: LLMProvider = {
    converse: async () => ({
      modelId: config.BEDROCK_MODEL_ID,
      durationMs: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 5 },
      message: {
        role: "assistant",
        content: [
          {
            text: JSON.stringify({
              summary: "A public rationale",
              preferredStrategy,
              veto: false,
              evidenceRefs,
              confidence: 0.6,
            }),
          },
        ],
      },
    }),
  };
  const service = new AgentAnalysisService(config, store, db, llm);
  assert.equal(
    (
      await service.process({
        tenantId: alice.userId,
        agentId: a.id,
        requestId,
      })
    ).status,
    "FAILED",
  );
  assert.equal(updates.length, 0);
  preferredStrategy = "momentum_v1";
  evidenceRefs = ["invented"];
  assert.equal(
    (
      await service.process({
        tenantId: alice.userId,
        agentId: a.id,
        requestId: randomUUID(),
      })
    ).status,
    "FAILED",
  );
  assert.equal(updates.length, 0);
  evidenceRefs = ["article-one"];
  const valid = randomUUID();
  assert.equal(
    (
      await service.process({
        tenantId: alice.userId,
        agentId: a.id,
        requestId: valid,
      })
    ).status,
    "COMPLETED",
  );
  assert.equal(updates.length, 1);
  await service.process({
    tenantId: alice.userId,
    agentId: a.id,
    requestId: valid,
  });
  assert.equal(updates.length, 1);
  assert.equal((await store.list(bob, "ANALYSIS")).items.length, 0);
});

test("DynamoDB requests carry exact tenant keys, conditional versions and atomic audit records", async () => {
  const sent: Record<string, unknown>[] = [];
  const db = {
    send: async (c: { input: Record<string, unknown> }) => {
      sent.push(c.input);
      return { Items: [] };
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoTenantStore(db, "control");
  await store.get(alice, "PROFILE", "self");
  await store.list(bob, "AGENT", 20);
  await store.commit(
    alice,
    [
      {
        kind: "MESSAGE_fixture",
        id: "message-one",
        expectedVersion: 0,
        data: { content: "public message", expiresAt: 12345 },
      },
    ],
    "message.saved",
  );
  assert.deepEqual(sent[0].Key, {
    pk: `TENANT#${alice.userId}`,
    sk: "PROFILE#self",
  });
  assert.deepEqual(sent[1].ExpressionAttributeValues, {
    ":pk": `TENANT#${bob.userId}`,
    ":sk": "AGENT#",
  });
  const items = sent[2].TransactItems as Array<{
    Put: { Item: Record<string, unknown>; ConditionExpression: string };
  }>;
  assert.equal(items.length, 3);
  assert.equal(items[0].Put.Item.expiresAt, 12345);
  assert.equal(items[1].Put.Item.expiresAt, 12345);
  assert.equal(items[0].Put.ConditionExpression, "attribute_not_exists(pk)");
  for (const op of items)
    assert.equal(op.Put.Item.pk, `TENANT#${alice.userId}`);
  assert.match(String(items[2].Put.Item.sk), /^AUDIT#/);
});
test("Bedrock tool schemas expand bounded strategy maps and retain strict object shapes", () => {
  const json = JSON.stringify(bedrockSchema(specSchema));
  assert.ok(!json.includes('"propertyNames"'));
  assert.ok(!json.includes('"minimum"'));
  assert.ok(json.includes('"additionalProperties":false'));
  assert.ok(json.includes('"breakout_v1"'));
  assert.ok(json.includes('"requireModelReview"'));
});
