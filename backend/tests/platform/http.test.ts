import { test } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createPlatform } from "../../src/server.js";
import {
  DynamoTenantStore,
  MemoryTenantStore,
} from "../../src/storage/tenant-store.js";
import { ProfileService } from "../../src/profiles/profile.service.js";
import { config, alice, FixtureRuntime } from "./helpers.js";

test("Malformed HTTP requests return safe 400/413 errors and unknown routes use the typed error envelope", async () => {
  const { app } = createPlatform(config, {
    store: new MemoryTenantStore(),
    runtime: new FixtureRuntime(),
    auth: { authenticate: async () => alice },
  });
  try {
    for (const [payload, status] of [
      ["{broken", 400],
      [JSON.stringify({ text: "x".repeat(66000) }), 413],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/platform/profile/preview",
        headers: { "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, status);
      assert.equal(response.json().error.code, "INVALID_HTTP_REQUEST");
      assert.equal(
        response.json().error.requestId,
        response.headers["x-request-id"],
      );
      assert.ok(!response.body.includes("x".repeat(100)));
    }
    const missing = await app.inject({
      method: "GET",
      url: "/platform/does-not-exist",
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("Concurrent Cognito session initialization preserves a single profile without spurious conflicts", async () => {
  const store = new MemoryTenantStore(),
    service = new ProfileService(store);
  await Promise.all(
    Array.from({ length: 3 }, () =>
      service.syncIdentity(alice, {
        email: "alice@fixture.test",
        displayName: "Alice",
        emailVerified: true,
      }),
    ),
  );
  const profile = await service.get(alice);
  assert.equal(profile.version, 1);
  assert.equal(profile.data.displayName, "Alice");
  const identity = await store.get(alice, "IDENTITY", "self");
  assert.equal(identity?.version, 3);
});

test("DynamoDB capacity/validation failures are not mislabeled as stale configuration conflicts", async () => {
  for (const reason of [
    "ConditionalCheckFailed",
    "ProvisionedThroughputExceeded",
    "ValidationError",
  ]) {
    const failure = Object.assign(
      new Error("Fixture transaction cancellation"),
      {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: reason }],
      },
    );
    const store = new DynamoTenantStore(
      {
        send: async () => {
          throw failure;
        },
      } as unknown as DynamoDBDocumentClient,
      "fixture-table",
    );
    await assert.rejects(
      store.commit(
        alice,
        [
          {
            kind: "CONFIG",
            id: "test",
            expectedVersion: 0,
            data: { value: 1 },
          },
        ],
        "fixture",
      ),
      (error: unknown) =>
        reason === "ConditionalCheckFailed"
          ? (error as { code?: string }).code === "CONFLICT"
          : error === failure,
    );
  }
});
