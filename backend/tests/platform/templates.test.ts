import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentService } from "../../src/agents/agent.service.js";
import { ProfileService } from "../../src/profiles/profile.service.js";
import { MemoryTenantStore } from "../../src/storage/tenant-store.js";
import { alice, bob, config, spec, FixtureRuntime } from "./helpers.js";
test("Managed templates and user-created agents have isolated versioned definitions; draft deletion releases quota", async () => {
  const store = new MemoryTenantStore(),
    runtime = new FixtureRuntime(),
    profiles = new ProfileService(store),
    agents = new AgentService(
      store,
      runtime,
      { ...config, KRONO_MAX_AGENT_SPECS_PER_USER: 2 },
      profiles,
    );
  const managed = await agents.fromTemplate(alice, "news-monitor"),
    custom = await agents.create(alice, spec());
  assert.equal(managed.data.origin, "KRONO_MANAGED");
  assert.equal(custom.data.origin, "USER_CREATED");
  assert.equal(managed.data.specification.permissions.executeTrades, false);
  assert.equal(managed.data.specification.type, "news_monitor");
  assert.equal(runtime.calls.length, 0);
  assert.deepEqual((await store.list(bob, "AGENT")).items, []);
  await assert.rejects(agents.create(alice, spec()), /quota/);
  await assert.rejects(
    agents.control(alice, custom.id, "TERMINATE", custom.version),
  );
  await agents.control(
    alice,
    custom.id,
    "TERMINATE",
    custom.version,
    `DELETE ${custom.id}`,
  );
  await assert.rejects(agents.get(alice, custom.id));
  const replacement = await agents.create(alice, spec());
  assert.notEqual(replacement.id, custom.id);
  assert.ok((await store.list(alice, `AGENT_SPEC_${custom.id}`)).items.length);
});
