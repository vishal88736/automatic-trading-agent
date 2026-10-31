import { randomBytes, timingSafeEqual } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  GlobalSignOutCommand,
  RevokeTokenCommand,
  GetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Principal } from "../domain/schemas.js";
import { PlatformError } from "../domain/errors.js";

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<Principal>;
}
export class CognitoAuth implements Authenticator {
  readonly verifier;
  constructor(
    private config: Config,
    private client = new CognitoIdentityProviderClient({
      region: config.AWS_REGION,
    }),
  ) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId: config.COGNITO_USER_POOL_ID,
      clientId: config.COGNITO_CLIENT_ID,
      tokenUse: "access",
    });
  }
  async authenticate(request: FastifyRequest): Promise<Principal> {
    const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const token = bearer ?? request.cookies.krono_access;
    if (!token)
      throw new PlatformError("UNAUTHENTICATED", "Sign in to KRONO", 401);
    if (!bearer && !["GET", "HEAD"].includes(request.method)) {
      const csrf = request.headers["x-krono-csrf"],
        cookie = request.cookies.krono_csrf;
      if (
        typeof csrf !== "string" ||
        !cookie ||
        csrf.length !== cookie.length ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(cookie))
      )
        throw new PlatformError(
          "CSRF",
          "Refresh your session and try again",
          403,
        );
    }
    try {
      const claims = await this.verifier.verify(token);
      return {
        userId: claims.sub,
        username: claims.username,
        accessToken: token,
      };
    } catch {
      throw new PlatformError(
        "UNAUTHENTICATED",
        "Your Cognito session expired; sign in again",
        401,
      );
    }
  }
  private cookies(
    reply: FastifyReply,
    result: { AccessToken?: string; RefreshToken?: string; ExpiresIn?: number },
  ) {
    if (!result.AccessToken)
      throw new PlatformError(
        "AUTH_CHALLENGE",
        "Complete the required Cognito authentication challenge",
        403,
      );
    const secure = this.config.KRONO_PUBLIC_ORIGIN.startsWith("https://"),
      base = {
        path: "/platform",
        sameSite: "strict" as const,
        secure,
        httpOnly: true,
      };
    reply.setCookie("krono_access", result.AccessToken, {
      ...base,
      maxAge: result.ExpiresIn ?? 3600,
    });
    if (result.RefreshToken)
      reply.setCookie("krono_refresh", result.RefreshToken, {
        ...base,
        maxAge: 86400 * 7,
      });
    const csrf = randomBytes(32).toString("hex");
    reply.setCookie("krono_csrf", csrf, { ...base, maxAge: 86400 * 7 });
    return { authenticated: true, csrf, expiresIn: result.ExpiresIn ?? 3600 };
  }
  routes(
    app: FastifyInstance,
    onIdentity?: (
      p: Principal,
      identity: { email: string; displayName: string; emailVerified: boolean },
    ) => Promise<void>,
  ) {
    const email = z.string().email().max(254),
      password = z.string().min(12).max(128),
      code = z.string().regex(/^\d{6,8}$/);
    app.post("/platform/auth/register", async (req) => {
      const data = z
        .object({ email, password, displayName: z.string().min(1).max(80) })
        .strict()
        .parse(req.body);
      await this.client.send(
        new SignUpCommand({
          ClientId: this.config.COGNITO_CLIENT_ID,
          Username: data.email,
          Password: data.password,
          UserAttributes: [
            { Name: "email", Value: data.email },
            { Name: "name", Value: data.displayName },
          ],
        }),
      );
      return {
        verificationRequired: true,
        message: "Check your email for a verification code",
      };
    });
    app.post("/platform/auth/verify", async (req) => {
      const data = z.object({ email, code }).strict().parse(req.body);
      await this.client.send(
        new ConfirmSignUpCommand({
          ClientId: this.config.COGNITO_CLIENT_ID,
          Username: data.email,
          ConfirmationCode: data.code,
        }),
      );
      return { verified: true };
    });
    app.post("/platform/auth/login", async (req, reply) => {
      const data = z
        .object({ email, password: z.string().min(1).max(128) })
        .strict()
        .parse(req.body);
      const result = await this.client.send(
        new InitiateAuthCommand({
          ClientId: this.config.COGNITO_CLIENT_ID,
          AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: data.email, PASSWORD: data.password },
        }),
      );
      return this.cookies(reply, result.AuthenticationResult ?? {});
    });
    app.post("/platform/auth/refresh", async (req, reply) => {
      const refresh = req.cookies.krono_refresh;
      if (!refresh)
        throw new PlatformError("UNAUTHENTICATED", "Sign in again", 401);
      const result = await this.client.send(
        new InitiateAuthCommand({
          ClientId: this.config.COGNITO_CLIENT_ID,
          AuthFlow: "REFRESH_TOKEN_AUTH",
          AuthParameters: { REFRESH_TOKEN: refresh },
        }),
      );
      return this.cookies(reply, result.AuthenticationResult ?? {});
    });
    app.post("/platform/auth/forgot", async (req) => {
      const data = z.object({ email }).strict().parse(req.body);
      await this.client.send(
        new ForgotPasswordCommand({
          ClientId: this.config.COGNITO_CLIENT_ID,
          Username: data.email,
        }),
      );
      return {
        message: "If the account is eligible, a reset code will be sent",
      };
    });
    app.post("/platform/auth/reset", async (req) => {
      const data = z.object({ email, code, password }).strict().parse(req.body);
      await this.client.send(
        new ConfirmForgotPasswordCommand({
          ClientId: this.config.COGNITO_CLIENT_ID,
          Username: data.email,
          ConfirmationCode: data.code,
          Password: data.password,
        }),
      );
      return { reset: true };
    });
    app.post("/platform/auth/logout", async (req, reply) => {
      try {
        try {
          const p = await this.authenticate(req);
          await this.client.send(
            new GlobalSignOutCommand({ AccessToken: p.accessToken }),
          );
        } catch (e) {
          if (!(e instanceof PlatformError) || e.code !== "UNAUTHENTICATED")
            throw e;
          if (req.cookies.krono_refresh)
            await this.client.send(
              new RevokeTokenCommand({
                ClientId: this.config.COGNITO_CLIENT_ID,
                Token: req.cookies.krono_refresh,
              }),
            );
        }
      } finally {
        for (const name of ["krono_access", "krono_refresh", "krono_csrf"])
          reply.clearCookie(name, { path: "/platform" });
      }
      return { signedOut: true };
    });
    app.get("/platform/auth/session", async (req) => {
      const p = await this.authenticate(req);
      const user = await this.client.send(
        new GetUserCommand({ AccessToken: p.accessToken }),
      );
      await onIdentity?.(p, {
        email:
          user.UserAttributes?.find((a) => a.Name === "email")?.Value ?? "",
        displayName: (
          user.UserAttributes?.find((a) => a.Name === "name")?.Value ?? "Trader"
        ).slice(0, 80),
        emailVerified:
          user.UserAttributes?.some(
            (a) => a.Name === "email_verified" && a.Value === "true",
          ) ?? false,
      });
      return {
        userId: p.userId,
        email: user.UserAttributes?.find((a) => a.Name === "email")?.Value,
        emailVerified: user.UserAttributes?.some(
          (a) => a.Name === "email_verified" && a.Value === "true",
        ),
        csrf: req.cookies.krono_csrf,
      };
    });
  }
}
