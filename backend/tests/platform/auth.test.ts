import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { CognitoAuth } from "../../src/auth/cognito.js";
import { config, alice } from "./helpers.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {
  CognitoIdentityProviderClient,
  RevokeTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";

test("Cognito validates signatures, issuer, client ID, expiry and token_use; cookie mutations require CSRF", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = "fixture-key",
    jwk = {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    };
  const auth = new CognitoAuth(config);
  auth.verifier.cacheJwks({ keys: [jwk] });
  const claims = {
    sub: alice.userId,
    username: "alice",
    iss: `https://cognito-idp.${config.AWS_REGION}.amazonaws.com/${config.COGNITO_USER_POOL_ID}`,
    client_id: config.COGNITO_CLIENT_ID,
    token_use: "access",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const jwt = (override: Record<string, unknown> = {}) => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString(
        "base64url",
      ),
      p = Buffer.from(JSON.stringify({ ...claims, ...override })).toString(
        "base64url",
      ),
      input = `${h}.${p}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  };
  const req = (
    token: string,
    method = "GET",
    cookies: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) =>
    ({
      method,
      cookies,
      headers: { authorization: `Bearer ${token}`, ...headers },
    }) as unknown as FastifyRequest;
  assert.equal((await auth.authenticate(req(jwt()))).userId, alice.userId);
  for (const override of [
    { iss: "https://evil.example" },
    { client_id: "otherclient" },
    { token_use: "id" },
    { exp: 1 },
  ])
    await assert.rejects(
      auth.authenticate(req(jwt(override))),
      /session expired/,
    );
  const forged = jwt().split(".");
  forged[1] = Buffer.from(
    JSON.stringify({ ...claims, sub: "forged" }),
  ).toString("base64url");
  await assert.rejects(auth.authenticate(req(forged.join("."))));
  const cookieReq = {
    method: "POST",
    cookies: { krono_access: jwt(), krono_csrf: "nonce" },
    headers: {},
  } as unknown as FastifyRequest;
  await assert.rejects(auth.authenticate(cookieReq), /Refresh/);
  cookieReq.headers["x-krono-csrf"] = "nonce";
  assert.equal((await auth.authenticate(cookieReq)).userId, alice.userId);
});

test("Logout revokes the refresh session after access-token expiry and always clears browser cookies", async () => {
  const commands: RevokeTokenCommand[] = [];
  let fail = false;
  const client = {
    async send(command: RevokeTokenCommand) {
      commands.push(command);
      if (fail) throw new Error("Fixture provider unavailable");
      return {};
    },
  } as unknown as CognitoIdentityProviderClient;
  const app = Fastify();
  app.register(cookie);
  new CognitoAuth(config, client).routes(app);
  try {
    for (const expectedStatus of [200, 500]) {
      const response = await app.inject({
        method: "POST",
        url: "/platform/auth/logout",
        headers: {
          cookie:
            "krono_access=expired; krono_refresh=fixture-refresh; krono_csrf=fixture-csrf",
          "x-krono-csrf": "fixture-csrf",
        },
      });
      assert.equal(response.statusCode, expectedStatus);
      for (const name of ["krono_access", "krono_refresh", "krono_csrf"])
        assert.ok(
          response.cookies.some((c) => c.name === name && c.value === ""),
        );
      assert.ok(commands.at(-1) instanceof RevokeTokenCommand);
      assert.equal(commands.at(-1)?.input.Token, "fixture-refresh");
      fail = true;
    }
    assert.equal(commands.length, 2);
  } finally {
    await app.close();
  }
});
