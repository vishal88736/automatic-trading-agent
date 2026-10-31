import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { AwsRuntime } from "../../src/runtime/aws-runtime.js";
import { MemoryTenantStore } from "../../src/storage/tenant-store.js";
import { AgentService } from "../../src/agents/agent.service.js";
import { ProfileService } from "../../src/profiles/profile.service.js";
import { alice, bob, config, spec, FixtureRuntime } from "./helpers.js";
test("CloudWatch continuation tokens are scoped through expiring tenant/deployment cursor records", async () => {
  const rows = new Map<string, Record<string, unknown>>(),
    calls: unknown[] = [];
  const db = {
    send: async (c: {
      input: { Item?: Record<string, unknown>; Key?: Record<string, unknown> };
    }) => {
      const x = c.input;
      if (x.Item)
        rows.set(JSON.stringify({ pk: x.Item.pk, sk: x.Item.sk }), x.Item);
      return { Item: x.Key ? rows.get(JSON.stringify(x.Key)) : undefined };
    },
  } as unknown as DynamoDBDocumentClient;
  const logs = {
    send: async (c: unknown) => {
      calls.push(c);
      return {
        events: [{ timestamp: 1, message: "fixture log" }],
        nextToken: "private-provider-token",
      };
    },
  } as unknown as CloudWatchLogsClient;
  const runtime = new AwsRuntime(
    config,
    db,
    undefined,
    undefined,
    undefined,
    undefined,
    logs,
  );
  const store = new MemoryTenantStore(),
    agents = new AgentService(
      store,
      new FixtureRuntime(),
      config,
      new ProfileService(store),
    );
  const a = (await agents.create(alice, spec())).data,
    b = (await agents.create(bob, spec())).data;
  a.deployment = {
    id: randomUUID(),
    stackName: "fixture",
    imageVersion: config.KRONO_AGENT_IMAGE,
    configurationVersion: 1,
    startedAt: new Date().toISOString(),
    expiresAt: 9999999999,
  };
  b.deployment = { ...a.deployment, id: randomUUID() };
  const page = await runtime.logs(alice, a);
  assert.notEqual(page.nextToken, "private-provider-token");
  await assert.rejects(
    runtime.logs(bob, b, 20, page.nextToken),
    /unauthorized/,
  );
  assert.equal(calls.length, 1);
  await runtime.logs(alice, a, 20, page.nextToken);
  assert.equal(calls.length, 2);
  const expired = [...rows.values()][0];
  expired.expiresAt = 1;
  await assert.rejects(runtime.logs(alice, a, 20, page.nextToken), /Expired/);
});
