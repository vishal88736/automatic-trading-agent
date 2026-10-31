import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentService } from "../../src/agents/agent.service.js";
import { ProfileService } from "../../src/profiles/profile.service.js";
import { MemoryTenantStore } from "../../src/storage/tenant-store.js";
import { alice, bob, config, spec, FixtureRuntime } from "./helpers.js";

test("Concurrent controls dispatch one restart; latched emergency prevents resume and cross-user policy changes", async () => {
  const store = new MemoryTenantStore(),
    runtime = new FixtureRuntime(),
    profiles = new ProfileService(store),
    agents = new AgentService(store, runtime, config, profiles);
  const draft = await agents.create(alice, spec()),
    preview = await agents.preview(alice, draft.id);
  await agents.deploy(alice, draft.id, {
    expectedVersion: preview.version,
    digest: preview.digest,
    acknowledgement: "DEPLOY_SIMULATION",
  });
  runtime.statuses.set(draft.id, "RUNNING");
  let current = (await agents.status(alice, draft.id)).agent;
  const attempted = await Promise.allSettled(
    [1, 2].map(() =>
      agents.control(alice, draft.id, "RESTART", current.version),
    ),
  );
  assert.equal(attempted.filter((a) => a.status === "fulfilled").length, 1);
  assert.equal(runtime.calls.filter((c) => c === "RESTART").length, 1);
  await agents.emergencyStop(alice);
  current = await agents.get(alice, draft.id);
  await assert.rejects(
    agents.control(alice, draft.id, "RESUME", current.version),
    /latched/,
  );
  assert.equal((await runtime.tenantPolicy(bob)).emergency, false);
  assert.equal((await runtime.tenantPolicy(alice)).emergency, true);
});
test("Failed upgrade retains the original runtime; lowering profile limits pauses running agents", async () => {
  const store = new MemoryTenantStore(),
    runtime = new FixtureRuntime(),
    profiles = new ProfileService(store),
    agents = new AgentService(store, runtime, config, profiles);
  const draft = await agents.create(alice, spec());
  let preview = await agents.preview(alice, draft.id);
  await agents.deploy(alice, draft.id, {
    expectedVersion: preview.version,
    digest: preview.digest,
    acknowledgement: "DEPLOY_SIMULATION",
  });
  runtime.statuses.set(draft.id, "RUNNING");
  let current = (await agents.status(alice, draft.id)).agent;
  const original = current.data.deployment!.id;
  await agents.update(
    alice,
    draft.id,
    { ...spec(), name: "Version two" },
    current.version,
  );
  preview = await agents.preview(alice, draft.id);
  await agents.deploy(alice, draft.id, {
    expectedVersion: preview.version,
    digest: preview.digest,
    acknowledgement: "DEPLOY_SIMULATION",
  });
  runtime.statuses.set(draft.id, "FAILED");
  const recovered = await agents.status(alice, draft.id);
  assert.equal(recovered.agent.data.deployment!.id, original);
  assert.equal(recovered.agent.data.state, "PAUSED");
  assert.equal(recovered.agent.data.deploymentVersion, 2);
  const profile = await profiles.get(alice);
  await agents.updateProfile(
    alice,
    {
      ...profile.data,
      riskProfile: { ...profile.data.riskProfile, maxDailyLoss: 0.01 },
    },
    profile.version,
  );
  current = await agents.get(alice, draft.id);
  await assert.rejects(
    agents.control(alice, draft.id, "RESUME", current.version),
    /exceeds/,
  );
});
