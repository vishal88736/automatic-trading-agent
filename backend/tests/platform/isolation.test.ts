import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryTenantStore } from "../../src/storage/tenant-store.js";
import { createPlatform } from "../../src/server.js";
import { PlatformError } from "../../src/domain/errors.js";
import { alice, bob, config, spec, FixtureRuntime } from "./helpers.js";

test("Every API resource derives its tenant from authentication; foreign IDs and cursors fail", async () => {
  const runtime = new FixtureRuntime(),
    store = new MemoryTenantStore();
  const { app } = createPlatform(config, {
    store,
    runtime,
    auth: {
      authenticate: async (r) => {
        if (r.headers.authorization === "Bearer alice") return alice;
        if (r.headers.authorization === "Bearer bob") return bob;
        throw new PlatformError("UNAUTHENTICATED", "Sign in", 401);
      },
    },
  });
  const call = (
    method: "GET" | "POST",
    url: string,
    user = "alice",
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${user}`,
        origin: config.KRONO_PUBLIC_ORIGIN,
      },
      payload: payload as object,
    });
  try {
    assert.equal((await call("GET", "/platform/profile")).statusCode, 200);
    const agent = (
      await call("POST", "/platform/agents", "alice", spec())
    ).json();
    const chat = (await call("POST", "/platform/conversations")).json();
    for (const path of [
      `/agents/${agent.id}`,
      `/agents/${agent.id}/preview`,
      `/agents/${agent.id}/events`,
      `/agents/${agent.id}/logs`,
      `/agents/${agent.id}/versions`,
      `/conversations/${chat.id}/messages`,
    ])
      assert.equal(
        (await call("GET", `/platform${path}`, "bob")).statusCode,
        404,
        path,
      );
    assert.deepEqual(
      (await call("GET", "/platform/agents", "bob")).json().items,
      [],
    );
    assert.equal(
      (
        await call("POST", "/platform/agents", "alice", {
          ...spec(),
          ownerId: bob.userId,
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await call("POST", `/platform/agents/${agent.id}/control`, "bob", {
          command: "STOP",
          expectedVersion: 1,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await call("GET", "/platform/profile", "nobody")).statusCode,
      401,
    );
    const crossCursor = Buffer.from(
      JSON.stringify({ pk: `TENANT#${alice.userId}`, sk: "AUDIT#a" }),
    ).toString("base64url");
    assert.equal(
      (
        await call(
          "GET",
          `/platform/history/AUDIT?cursor=${crossCursor}`,
          "bob",
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/platform/agents",
          headers: {
            authorization: "Bearer alice",
            origin: "https://evil.example",
          },
          payload: spec(),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await call("POST", "/platform/agents", "alice", {
          ...spec(),
          execution: { ...spec().execution, mode: "LIVE" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await call("POST", "/platform/agents", "alice", {
          ...spec(),
          permissions: { ...spec().permissions, modifyRiskSettings: true },
        })
      ).statusCode,
      422,
    );
  } finally {
    await app.close();
  }
});

test("Versioned transactions are atomic under concurrent writes and approvals are single-use", async () => {
  const store = new MemoryTenantStore();
  await store.commit(
    alice,
    [{ kind: "CONFIG", id: "limit", expectedVersion: 0, data: 1 }],
    "fixture",
  );
  const attempts = await Promise.allSettled(
    [2, 3].map((data) =>
      store.commit(
        alice,
        [{ kind: "CONFIG", id: "limit", expectedVersion: 1, data }],
        "updated",
      ),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  const { app, tools, profiles } = createPlatform(config, {
    store,
    runtime: new FixtureRuntime(),
    auth: { authenticate: async () => alice },
  });
  try {
    const old = await profiles.get(alice),
      pending = await tools.pending(alice, "PROFILE_UPDATE", {
        profile: { ...old.data, displayName: "Alice" },
        expectedVersion: old.version,
      });
    await assert.rejects(tools.approve(bob, pending.actionId, pending.digest));
    await tools.approve(alice, pending.actionId, pending.digest);
    await assert.rejects(
      tools.approve(alice, pending.actionId, pending.digest),
    );
    assert.equal((await profiles.get(alice)).data.displayName, "Alice");
    assert.notEqual((await profiles.get(bob)).data.displayName, "Alice");
    await assert.rejects(
      tools.call(alice, "execute_shell", { command: "whoami" }),
    );
    await assert.rejects(
      tools.call(alice, "inspect_agent", {
        agentId: randomUUID(),
        ownerId: bob.userId,
      }),
    );
  } finally {
    await app.close();
  }
});
