import { createHash, createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { PlatformError } from "../domain/errors.js";

export function registerProductRoutes(app: FastifyInstance, config: Config) {
  const api = config.KRONO_PRODUCT_API_URL;
  const key = config.KRONO_PRODUCT_API_KEY;
  const routes = [
    { method: ["GET", "POST"], url: "/platform/paper-account" },
    { method: "POST", url: "/platform/paper-account/reset" },
    { method: "PUT", url: "/platform/paper-account/emergency" },
    { method: "GET", url: "/platform/paper-portfolio" },
    { method: ["GET", "POST"], url: "/platform/paper-orders" },
    { method: "POST", url: "/platform/paper-orders/:id/cancel" },
    { method: "POST", url: "/platform/paper-orders/:id/evaluate" },
    { method: ["GET", "POST"], url: "/platform/custom-strategies" },
    { method: ["GET", "PUT"], url: "/platform/custom-strategies/:id" },
    { method: "POST", url: "/platform/custom-strategies/:id/archive" },
    { method: "GET", url: "/platform/custom-strategies/:id/versions" },
    {
      method: "POST",
      url: "/platform/custom-strategies/:id/backtests",
      timeout: 25000,
    },
    { method: "GET", url: "/platform/backtests/:id" },
  ] as const;
  for (const route of routes) {
    const { method, url } = route;
    app.route({
      method: typeof method === "string" ? method : [...method],
      url,
      async handler(req, reply) {
        if (!api || !key) {
          throw new PlatformError(
            "PRODUCT_API_UNAVAILABLE",
            "Paper accounts and custom strategies are unavailable",
            503,
          );
        }
        const path = req.url;
        if (!path.startsWith("/platform/")) {
          throw new PlatformError(
            "INVALID_HTTP_REQUEST",
            "Invalid request path",
            400,
          );
        }
        const subject = req.principal.userId;
        const expires = String(Math.floor(Date.now() / 1000) + 20);
        const body = req.body === undefined ? "" : JSON.stringify(req.body);
        const digest = createHash("sha256").update(body).digest("hex");
        const message = [expires, subject, req.method, path, digest].join("\n");
        const signature = createHmac("sha256", key)
          .update(message)
          .digest("hex");
        const response = await fetch(new URL(api).origin + path, {
          method: req.method,
          headers: {
            "x-krono-product-sub": subject,
            "x-krono-product-expires": expires,
            "x-krono-product-signature": signature,
            ...(body && { "content-type": "application/json" }),
          },
          body: body || undefined,
          redirect: "error",
          signal: AbortSignal.timeout(
            "timeout" in route ? route.timeout : 8000,
          ),
        });
        if (response.status === 204) return reply.code(204).send();
        if (response.status === 401 || response.status >= 500) {
          throw new PlatformError(
            "PRODUCT_API_UNAVAILABLE",
            "Paper account service is temporarily unavailable",
            503,
          );
        }
        const data = await response.json();
        if (!response.ok) {
          const { error } = data as { error?: Record<string, unknown> };
          return reply.code(response.status).send({
            error: { ...error, requestId: req.id },
          });
        }
        return reply.code(response.status).send(data);
      },
    });
  }
}
