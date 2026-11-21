import { createHash, createHmac } from "node:crypto";
import type { Config } from "../config.js";
import { PlatformError } from "../domain/errors.js";

// The product API reserves its account routes for this subject.
export const SERVICE_SUBJECT = "00000000-0000-0000-0000-000000000000";

export type ProductForward = (
  subject: string,
  method: string,
  path: string,
  payload?: unknown,
  timeout?: number,
) => Promise<Response>;

/** Signs each request with the subject, expiry, method, raw path and body digest. */
export function productClient(config: Config): ProductForward {
  const api = config.KRONO_PRODUCT_API_URL;
  const key = config.KRONO_PRODUCT_API_KEY;
  return async (subject, method, path, payload, timeout = 8000) => {
    if (!api || !key) {
      throw new PlatformError(
        "PRODUCT_API_UNAVAILABLE",
        "Paper accounts and custom strategies are unavailable",
        503,
      );
    }
    if (!path.startsWith("/platform/")) {
      throw new PlatformError(
        "INVALID_HTTP_REQUEST",
        "Invalid request path",
        400,
      );
    }
    const expires = String(Math.floor(Date.now() / 1000) + 20);
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const digest = createHash("sha256").update(body).digest("hex");
    const message = [expires, subject, method, path, digest].join("\n");
    const signature = createHmac("sha256", key).update(message).digest("hex");
    return fetch(new URL(api).origin + path, {
      method,
      headers: {
        "x-krono-product-sub": subject,
        "x-krono-product-expires": expires,
        "x-krono-product-signature": signature,
        ...(body && { "content-type": "application/json" }),
      },
      body: body || undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  };
}
