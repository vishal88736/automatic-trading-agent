import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Principal } from "../domain/schemas.js";
import { PlatformError } from "../domain/errors.js";
import { SERVICE_SUBJECT, type ProductForward } from "../product/client.js";
import type { Authenticator } from "./cognito.js";
import {
  googleKeys,
  verifyGoogleIdToken,
  type GoogleKeySource,
} from "./google.js";

const SESSION_SECONDS = 7 * 86400;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface User {
  id: string;
  email: string;
  display_name: string;
}

/**
 * Self-hosted sign-in. Accounts live in the product database; the gateway issues an
 * HMAC-signed session cookie plus the same double-submit CSRF token as the Cognito flow.
 */
export class LocalAuth implements Authenticator {
  private secret: Buffer;
  constructor(
    private config: Config,
    private forward: ProductForward,
    private googleKeySource: GoogleKeySource = googleKeys(),
  ) {
    const material =
      config.KRONO_SESSION_SECRET ?? config.KRONO_PRODUCT_API_KEY;
    if (!material)
      throw Error("Local sign-in requires a session secret or product API key");
    this.secret = createHash("sha256")
      .update("krono-local-session\n" + material)
      .digest();
  }

  private sign(payload: string) {
    return createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
  }

  private token(userId: string) {
    const payload = `${userId}.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
    return `${payload}.${this.sign(payload)}`;
  }

  private read(token: string | undefined): string | null {
    const [userId, expires, signature] = token?.split(".") ?? [];
    if (!userId || !expires || !signature || !uuid.test(userId)) return null;
    const expected = Buffer.from(this.sign(`${userId}.${expires}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return null;
    return Number(expires) > Date.now() / 1000 ? userId : null;
  }

  async authenticate(request: FastifyRequest): Promise<Principal> {
    const userId = this.read(request.cookies.krono_session);
    if (!userId)
      throw new PlatformError("UNAUTHENTICATED", "Sign in to Krono", 401);
    if (!["GET", "HEAD"].includes(request.method)) {
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
    return { userId, username: userId, accessToken: "" };
  }

  private issue(reply: FastifyReply, userId: string) {
    const base = {
      path: "/platform",
      sameSite: "strict" as const,
      secure: this.config.KRONO_PUBLIC_ORIGIN.startsWith("https://"),
      httpOnly: true,
      maxAge: SESSION_SECONDS,
    };
    reply.setCookie("krono_session", this.token(userId), base);
    const csrf = randomBytes(32).toString("hex");
    reply.setCookie("krono_csrf", csrf, base);
    return { authenticated: true, csrf, expiresIn: SESSION_SECONDS };
  }

  private async call(path: string, method: string, body?: unknown) {
    const response = await this.forward(SERVICE_SUBJECT, method, path, body);
    if (response.status >= 500)
      throw new PlatformError(
        "PRODUCT_API_UNAVAILABLE",
        "The account service is unavailable",
        503,
      );
    const data = (await response.json()) as {
      user?: User;
      error?: { message?: string };
    };
    return { status: response.status, data };
  }

  routes(app: FastifyInstance) {
    const email = z.string().trim().email().max(254);
    app.post("/platform/auth/register", async (req, reply) => {
      const input = z
        .object({
          email,
          password: z.string().min(8).max(128),
          displayName: z.string().trim().min(1).max(80),
        })
        .strict()
        .parse(req.body);
      const { status, data } = await this.call(
        "/platform/internal/users",
        "POST",
        {
          email: input.email,
          password: input.password,
          display_name: input.displayName,
        },
      );
      if (status === 409)
        throw new PlatformError(
          "ACCOUNT_EXISTS",
          "An account with this email already exists. Sign in instead.",
          409,
        );
      if (status !== 201 || !data.user)
        throw new PlatformError(
          "VALIDATION",
          data.error?.message ?? "Check the registration fields",
          422,
        );
      return {
        verificationRequired: false,
        ...this.issue(reply, data.user.id),
      };
    });
    app.post("/platform/auth/login", async (req, reply) => {
      const input = z
        .object({ email, password: z.string().min(1).max(128) })
        .strict()
        .parse(req.body);
      const { status, data } = await this.call(
        "/platform/internal/sessions",
        "POST",
        input,
      );
      if (status !== 200 || !data.user)
        throw new PlatformError(
          "AUTHENTICATION",
          "Sign-in failed. Check your email and password.",
          401,
        );
      return this.issue(reply, data.user.id);
    });
    // Which sign-in methods this deployment offers; the UI shows Google only when set.
    app.get("/platform/auth/providers", async () => ({
      google: this.config.KRONO_GOOGLE_CLIENT_ID
        ? { clientId: this.config.KRONO_GOOGLE_CLIENT_ID }
        : null,
    }));
    app.post("/platform/auth/google", async (req, reply) => {
      const clientId = this.config.KRONO_GOOGLE_CLIENT_ID;
      if (!clientId)
        throw new PlatformError(
          "UNSUPPORTED",
          "Google sign-in is not configured for this deployment.",
          501,
        );
      const { credential } = z
        .object({ credential: z.string().min(20).max(8192) })
        .strict()
        .parse(req.body);
      let identity;
      try {
        identity = await verifyGoogleIdToken(
          credential,
          clientId,
          this.googleKeySource,
        );
      } catch {
        throw new PlatformError(
          "GOOGLE_UNAVAILABLE",
          "Google sign-in is unavailable. Try again shortly.",
          503,
        );
      }
      if (!identity)
        throw new PlatformError(
          "AUTHENTICATION",
          "Google sign-in failed. Try again.",
          401,
        );
      const { status, data } = await this.call(
        "/platform/internal/google-sessions",
        "POST",
        {
          subject: identity.subject,
          email: identity.email,
          display_name: identity.displayName,
        },
      );
      if (status === 409)
        throw new PlatformError(
          "ACCOUNT_EXISTS",
          "This email is linked to a different Google account.",
          409,
        );
      if (status !== 200 || !data.user)
        throw new PlatformError(
          "AUTHENTICATION",
          "Google sign-in failed. Try again.",
          401,
        );
      return this.issue(reply, data.user.id);
    });
    app.post("/platform/auth/refresh", async (req, reply) => {
      const userId = this.read(req.cookies.krono_session);
      if (!userId)
        throw new PlatformError("UNAUTHENTICATED", "Sign in again", 401);
      return this.issue(reply, userId);
    });
    app.post("/platform/auth/logout", async (_req, reply) => {
      for (const name of ["krono_session", "krono_csrf"])
        reply.clearCookie(name, { path: "/platform" });
      return { signedOut: true };
    });
    const unsupported = async () => {
      throw new PlatformError(
        "UNSUPPORTED",
        "Self-hosted accounts have no email delivery. Ask the operator to reset the password.",
        501,
      );
    };
    app.post("/platform/auth/verify", unsupported);
    app.post("/platform/auth/forgot", unsupported);
    app.post("/platform/auth/reset", unsupported);
    app.get("/platform/auth/session", async (req) => {
      const principal = await this.authenticate(req);
      const { status, data } = await this.call(
        `/platform/internal/users/${principal.userId}`,
        "GET",
      );
      if (status !== 200 || !data.user)
        throw new PlatformError("UNAUTHENTICATED", "Sign in again", 401);
      return {
        userId: data.user.id,
        email: data.user.email,
        displayName: data.user.display_name,
        emailVerified: true,
        csrf: req.cookies.krono_csrf,
      };
    });
  }
}
