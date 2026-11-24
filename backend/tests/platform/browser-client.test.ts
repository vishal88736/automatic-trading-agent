import assert from "node:assert/strict";
import { test } from "node:test";
import { platform } from "../../../frontend/src/platform/client.js";

test("an early mutation loads its CSRF token and a stale tab retries only for the same account", async (t) => {
  let session = { userId: "alice", csrf: "first-token" };
  const writes: string[] = [];
  const actions: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (input === "/platform/auth/session") {
      actions.push("session");
      return Response.json(session);
    }
    assert.equal(input, "/platform/paper-account");
    assert.equal(init?.method, "POST");
    if (new Headers(init.headers).get("x-krono-csrf") !== session.csrf) {
      actions.push("rejected");
      return Response.json({ error: { code: "CSRF" } }, { status: 403 });
    }
    actions.push("accepted");
    writes.push(session.userId);
    return Response.json({ ok: true });
  });

  await platform("/paper-account", "POST");
  assert.deepEqual(actions.splice(0), ["session", "accepted"]);

  session = { userId: "alice", csrf: "rotated-token" };
  await platform("/paper-account", "POST");
  assert.deepEqual(actions.splice(0), ["rejected", "session", "accepted"]);

  session = { userId: "bob", csrf: "different-account-token" };
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(platform("/paper-account", "POST"), /account changed/);
  assert.deepEqual(actions, ["rejected", "session", "rejected", "session"]);
  assert.deepEqual(writes, ["alice", "alice"]);
});
