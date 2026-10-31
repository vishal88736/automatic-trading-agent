import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryTenantStore } from "../../src/storage/tenant-store.js";
import { ProfileService } from "../../src/profiles/profile.service.js";
import { AgentService, digest } from "../../src/agents/agent.service.js";
import { agentTemplate } from "../../src/runtime/agent-template.js";
import { alice, bob, config, spec, FixtureRuntime } from "./helpers.js";
test("Deployment requires a current digest; observed health controls state, configurations remain immutable", async () => {
  assert.equal(
    digest({
      name: "agent",
      nested: { assets: ["BTC", "ETH"], mode: "SIMULATION" },
    }),
    digest({
      nested: { mode: "SIMULATION", assets: ["BTC", "ETH"] },
      name: "agent",
    }),
    "DynamoDB map ordering must not invalidate an unchanged approval",
  );
  const store = new MemoryTenantStore(),
    runtime = new FixtureRuntime(),
    profiles = new ProfileService(store),
    agents = new AgentService(store, runtime, config, profiles);
  const draft = await agents.create(alice, spec()),
    preview = await agents.preview(alice, draft.id);
  const approval = {
    expectedVersion: preview.version,
    digest: preview.digest,
    acknowledgement: "DEPLOY_SIMULATION",
  };
  await assert.rejects(
    agents.deploy(alice, draft.id, { ...approval, digest: "0".repeat(64) }),
  );
  assert.equal(runtime.calls.length, 0);
  const deployed = await agents.deploy(alice, draft.id, approval);
  assert.equal(deployed.data.state, "DEPLOYING");
  assert.equal(
    (await agents.status(alice, draft.id)).agent.data.state,
    "HEALTH_CHECK",
  );
  runtime.statuses.set(draft.id, "RUNNING");
  let current = (await agents.status(alice, draft.id)).agent;
  assert.equal(current.data.state, "RUNNING");
  await assert.rejects(agents.deploy(alice, draft.id, approval));
  const template = JSON.stringify(
    agentTemplate(config, alice, current.data, current.data.deployment!),
  );
  assert.match(
    template,
    new RegExp(`TENANT#${alice.userId}#AGENT#${draft.id}`),
  );
  assert.ok(!template.includes(bob.userId));
  assert.ok(!template.includes(`table/${config.KRONO_CONTROL_TABLE}\"`));
  assert.ok(template.includes('"AssignPublicIp":"DISABLED"'));
  assert.ok(!template.includes("bedrock:InvokeModel"));
  for (const command of ["PAUSE", "RESUME", "RESTART", "STOP"] as const) {
    await agents.control(alice, draft.id, command, current.version);
    current = await agents.get(alice, draft.id);
  }
  assert.deepEqual(runtime.calls.slice(-4), [
    "PAUSE",
    "RESUME",
    "RESTART",
    "STOP",
  ]);
  await assert.rejects(
    agents.control(alice, draft.id, "TERMINATE", current.version),
  );
  const updated = await agents.update(
    alice,
    draft.id,
    { ...spec(), name: "Revised" },
    current.version,
  );
  assert.equal(updated.data.configurationVersion, 2);
  assert.equal(
    (await store.get(alice, `AGENT_SPEC_${draft.id}`, "1"))?.version,
    1,
  );
});
test("Risk, unsupported providers, monitoring permissions and concurrent deployment quotas fail closed", async () => {
  const store = new MemoryTenantStore(),
    runtime = new FixtureRuntime(),
    profiles = new ProfileService(store),
    agents = new AgentService(
      store,
      runtime,
      { ...config, KRONO_MAX_AGENTS_PER_USER: 1 },
      profiles,
    );
  await assert.rejects(
    agents.create(alice, {
      ...spec(),
      riskPolicy: { ...spec().riskPolicy, maxDailyLoss: 0.04 },
    }),
  );
  await assert.rejects(
    agents.create(alice, {
      ...spec(),
      type: "research",
      permissions: { ...spec().permissions, executeTrades: true },
    }),
  );
  await assert.rejects(
    agents.create(alice, {
      ...spec(),
      configuration: { ...spec().configuration, assets: ["HSK"] },
    }),
  );
  const drafts = await Promise.all([
    agents.create(alice, spec()),
    agents.create(alice, { ...spec(), name: "Other agent" }),
  ]);
  const previews = await Promise.all(
    drafts.map((d) => agents.preview(alice, d.id)),
  );
  const results = await Promise.allSettled(
    previews.map((p) =>
      agents.deploy(alice, p.id, {
        expectedVersion: p.version,
        digest: p.digest,
        acknowledgement: "DEPLOY_SIMULATION",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(runtime.calls.filter((c) => c.startsWith("deploy")).length, 1);
});
