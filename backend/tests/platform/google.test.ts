import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { LocalAuth } from "../../gateway/auth/local.js";
import { verifyGoogleIdToken } from "../../gateway/auth/google.js";
import { PlatformError } from "../../gateway/domain/errors.js";
import {
  SERVICE_SUBJECT,
  type ProductForward,
} from "../../gateway/product/client.js";
import { config } from "./helpers.js";

const CLIENT_ID = "1234-test.apps.googleusercontent.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "key-1",
} as JsonWebKey & {
  kid: string;
};
const keys = async () => [jwk];
const now = Math.floor(Date.now() / 1000);

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "RS256", kid: "key-1", typ: "JWT", ...header });
  const body = encode({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-subject-1",
    email: "ana@example.com",
    email_verified: true,
    name: "Ana Trader",
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    privateKey,
  ).toString("base64url");
  return `${head}.${body}.${signature}`;
}

test("Google ID tokens are accepted only with a valid signature and claims", async () => {
  assert.deepEqual(await verifyGoogleIdToken(token(), CLIENT_ID, keys), {
    subject: "google-subject-1",
    email: "ana@example.com",
    displayName: "Ana Trader",
  });
  for (const forged of [
    token({ aud: "other.apps.googleusercontent.com" }),
    token({ iss: "https://evil.example" }),
    token({ exp: now - 3600 }),
    token({ email_verified: false }),
    token({ sub: "" }),
    token({}, { alg: "none" }),
    token({}, { kid: "unknown" }),
    token().replace(/\.[^.]+$/, ".AAAA"),
    // A valid signature over different claims must not verify.
    `${token().split(".")[0]}.${token({ sub: "attacker" }).split(".")[1]}.${token().split(".")[2]}`,
    "not-a-jwt",
  ])
    assert.equal(await verifyGoogleIdToken(forged, CLIENT_ID, keys), null);
});

test("Google sign-in creates a session through the product API, which keeps the record", async () => {
  const userId = "22222222-2222-4222-8222-222222222222";
  const calls: Array<[string, string, string, unknown]> = [];
  const forward: ProductForward = async (subject, method, path, body) => {
    calls.push([subject, method, path, body]);
    const user = { id: userId, email: "ana@example.com", display_name: "Ana" };
    if (path === "/platform/internal/google-sessions")
      return Response.json({ user });
    if (path === `/platform/internal/users/${userId}`)
      return Response.json({ user });
    return Response.json({}, { status: 404 });
  };
  async function server(clientId?: string) {
    const auth = new LocalAuth(
      {
        ...config,
        KRONO_AUTH_MODE: "local",
        KRONO_SESSION_SECRET: "s".repeat(32),
        KRONO_GOOGLE_CLIENT_ID: clientId,
      },
      forward,
      keys,
    );
    const app = Fastify();
    await app.register(cookie);
    app.setErrorHandler((error, _req, reply) =>
      reply
        .status(error instanceof PlatformError ? error.status : 400)
        .send({ error: { message: error.message } }),
    );
    auth.routes(app);
    return app;
  }

  const disabled = await server();
  assert.deepEqual(
    (await disabled.inject({ url: "/platform/auth/providers" })).json(),
    { google: null },
  );
  assert.equal(
    (
      await disabled.inject({
        method: "POST",
        url: "/platform/auth/google",
        payload: { credential: token() },
      })
    ).statusCode,
    501,
  );

  const app = await server(CLIENT_ID);
  assert.deepEqual(
    (await app.inject({ url: "/platform/auth/providers" })).json(),
    { google: { clientId: CLIENT_ID } },
  );
  const rejected = await app.inject({
    method: "POST",
    url: "/platform/auth/google",
    payload: { credential: token({ aud: "someone-else" }) },
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(calls.length, 0);

  const signedIn = await app.inject({
    method: "POST",
    url: "/platform/auth/google",
    payload: { credential: token() },
  });
  assert.equal(signedIn.statusCode, 200);
  assert.deepEqual(calls[0], [
    SERVICE_SUBJECT,
    "POST",
    "/platform/internal/google-sessions",
    {
      subject: "google-subject-1",
      email: "ana@example.com",
      display_name: "Ana Trader",
    },
  ]);
  const jar = Object.fromEntries(
    signedIn.cookies.map((c) => [c.name, c.value]),
  );
  assert.ok(jar.krono_session && jar.krono_csrf);
  const session = await app.inject({
    url: "/platform/auth/session",
    cookies: jar,
  });
  assert.equal(session.json().userId, userId);
});
