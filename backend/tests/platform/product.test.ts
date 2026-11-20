import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createPlatform } from "../../src/server.js";
import { PlatformError } from "../../src/domain/errors.js";
import { MemoryTenantStore } from "../../src/storage/tenant-store.js";
import { alice, bob, config, FixtureRuntime } from "./helpers.js";

test("Product gateway signs exact authenticated requests and discards incoming internal identity headers", async () => {
  const key = "local-product-gateway-test".repeat(2);
  const forwarded: {
    path: string;
    subject: string | undefined;
    valid: boolean;
    body: string;
  }[] = [];
  const api = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const subject = req.headers["x-krono-product-sub"] as string | undefined;
    const message = [
      req.headers["x-krono-product-expires"],
      subject,
      req.method,
      req.url,
      createHash("sha256").update(body).digest("hex"),
    ].join("\n");
    forwarded.push({
      path: req.url!,
      subject,
      body,
      valid:
        req.headers["x-krono-product-signature"] ===
        createHmac("sha256", key).update(message).digest("hex"),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const { app } = createPlatform(
    {
      ...config,
      KRONO_PRODUCT_API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      KRONO_PRODUCT_API_KEY: key,
    },
    {
      store: new MemoryTenantStore(),
      runtime: new FixtureRuntime(),
      auth: {
        authenticate: async (req) => {
          if (req.headers.authorization !== "Bearer fixture")
            throw new PlatformError("UNAUTHENTICATED", "Sign in", 401);
          return alice;
        },
      },
    },
  );
  try {
    const path = "/platform/custom-strategies";
    const anonymous = await app.inject({ method: "GET", url: path });
    assert.equal(anonymous.statusCode, 401);
    const headers = {
      authorization: "Bearer fixture",
      "x-krono-product-sub": bob.userId,
      "x-krono-product-signature": "ignored",
      "x-krono-product-expires": "ignored",
    };
    const foreignOrigin = await app.inject({
      method: "GET",
      url: path,
      headers: { ...headers, origin: "https://untrusted.example" },
    });
    assert.equal(foreignOrigin.statusCode, 403);
    const list = await app.inject({
      method: "GET",
      url: path + "?limit=1",
      headers,
    });
    assert.equal(list.statusCode, 200);
    const payload = { name: "Strategy Δ", definition: {} };
    const create = await app.inject({
      method: "POST",
      url: path,
      headers,
      payload,
    });
    assert.equal(create.statusCode, 200);
    assert.deepEqual(forwarded, [
      { path: path + "?limit=1", subject: alice.userId, body: "", valid: true },
      {
        path,
        subject: alice.userId,
        body: JSON.stringify(payload),
        valid: true,
      },
    ]);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
