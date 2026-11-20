import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { PlatformError } from "../domain/errors.js";
import type { LLMProvider } from "../integrations/llm/llm.interface.js";
import {
  bedrockSchema,
  validateOutput,
} from "../integrations/llm/structured-output.js";

const objectiveSchema = z
  .object({ objective: z.string().trim().min(10).max(2000) })
  .strict();
const draftSchema = z
  .object({
    strategy_json: z.string().max(16000),
    notes: z.string().max(1200),
  })
  .strict();

const marketEvidence = z.object({
  market: z.object({
    source: z.string(),
    status: z.string(),
    as_of: z.string().nullable(),
    price: z.union([z.string(), z.number()]).nullable(),
    price_at: z.string().nullable(),
  }),
  indicators: z
    .object({
      rsi: z.union([z.string(), z.number()]).nullish(),
      atr: z.union([z.string(), z.number()]).nullish(),
      macd: z.union([z.string(), z.number()]).nullish(),
      regime: z.string().nullish(),
    })
    .nullable(),
});
const insightSchema = z
  .object({
    observations: z.string().max(1000),
    uncertainty: z.string().max(600),
  })
  .strict();

export function registerProductRoutes(
  app: FastifyInstance,
  config: Config,
  llm: LLMProvider,
) {
  const api = config.KRONO_PRODUCT_API_URL;
  const key = config.KRONO_PRODUCT_API_KEY;
  async function forward(
    subject: string,
    method: string,
    path: string,
    payload?: unknown,
    timeout = 8000,
  ) {
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
      method: method,
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
  }

  app.post("/platform/market-insights/:asset", async (req) => {
    const { asset } = z
      .object({ asset: z.enum(["BTC", "ETH", "SOL"]) })
      .parse(req.params);
    const response = await forward(
      req.principal.userId,
      "GET",
      `/platform/paper-market/${asset}`,
      undefined,
      22000,
    );
    const evidence = response.ok
      ? marketEvidence.safeParse(await response.json())
      : null;
    if (
      !evidence?.success ||
      !evidence.data.indicators ||
      evidence.data.market.price === null ||
      !evidence.data.market.as_of ||
      !(
        evidence.data.market.status === "AVAILABLE" ||
        (config.NODE_ENV === "test" &&
          evidence.data.market.status === "FIXTURE")
      )
    ) {
      throw new PlatformError(
        "MARKET_UNAVAILABLE",
        "Current market evidence is unavailable",
        503,
      );
    }
    const result = await llm.converse({
      context: {
        userId: req.principal.userId,
        sessionId: "market-insights",
        requestId: req.id,
      },
      system:
        "Summarize only the supplied market observations and their uncertainty. Never add market facts, forecasts, trade instructions or promises of returns. Give a short description and explain what the indicators cannot establish.",
      messages: [
        {
          role: "user",
          content: [{ text: JSON.stringify({ asset, ...evidence.data }) }],
        },
      ],
      outputSchema: {
        name: "paper_market_insight",
        schema: bedrockSchema(insightSchema),
      },
    });
    const output = result.message.content
      .flatMap((entry) => ("text" in entry ? [entry.text] : []))
      .join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new PlatformError(
        "INVALID_MODEL_OUTPUT",
        "The model did not return a valid insight",
        422,
      );
    }
    return {
      ...validateOutput(insightSchema, parsed),
      asset,
      source: evidence.data.market.source,
      status: evidence.data.market.status,
      asOf: evidence.data.market.as_of,
      model: result.modelId,
    };
  });

  app.post("/platform/strategy-authoring/generate", async (req) => {
    const { objective } = objectiveSchema.parse(req.body);
    const subject = req.principal.userId;
    const options = await forward(
      subject,
      "GET",
      "/platform/strategy-authoring",
    );
    if (!options.ok)
      throw new PlatformError(
        "PRODUCT_API_UNAVAILABLE",
        "Strategy authoring is unavailable",
        503,
      );
    const { schema } = (await options.json()) as {
      schema: Record<string, unknown>;
    };
    const response = await llm.converse({
      context: {
        userId: subject,
        sessionId: "strategy-authoring",
        requestId: req.id,
      },
      system: `Translate the user's objective into an editable, long-only hourly paper strategy. Return the strategy as a JSON string in strategy_json, matching this schema: ${JSON.stringify(schema)}. Use fractions (2% is 0.02), never invent an indicator or market. Explain defaults in notes. For unsupported instructions, leave strategy_json empty and explain in notes. Return no forecasts. This drafts a document and cannot save it or place orders.`,
      messages: [{ role: "user", content: [{ text: objective }] }],
      outputSchema: {
        name: "paper_strategy_draft",
        schema: bedrockSchema(draftSchema),
      },
    });
    const output = response.message.content
      .flatMap((entry) => ("text" in entry ? [entry.text] : []))
      .join("");
    const invalid = () =>
      new PlatformError(
        "INVALID_MODEL_OUTPUT",
        "The model did not return a valid paper strategy",
        422,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw invalid();
    }
    const candidate = validateOutput(draftSchema, parsed);
    if (!candidate.strategy_json)
      return {
        document: null,
        notes: candidate.notes,
        model: response.modelId,
      };
    let document: unknown;
    try {
      document = JSON.parse(candidate.strategy_json);
    } catch {
      throw invalid();
    }
    const validation = await forward(
      subject,
      "POST",
      "/platform/strategy-authoring/validate",
      document,
    );
    if (validation.status === 422) throw invalid();
    if (!validation.ok)
      throw new PlatformError(
        "PRODUCT_API_UNAVAILABLE",
        "Strategy validation is unavailable",
        503,
      );
    const validated = (await validation.json()) as { document: unknown };
    return {
      document: validated.document,
      notes: candidate.notes,
      model: response.modelId,
    };
  });
  app.get("/platform/paper-agents/:id/stream", async (req, reply) => {
    const response = await forward(
      req.principal.userId,
      "GET",
      req.url,
      undefined,
      30000,
    );
    if (!response.ok || !response.body)
      throw new PlatformError(
        "STREAM_UNAVAILABLE",
        "Agent event stream unavailable",
        503,
      );
    const stream = Readable.fromWeb(response.body as unknown as ReadableStream);
    reply.raw.once("close", () => stream.destroy());
    return reply
      .header("cache-control", "no-store")
      .header("x-accel-buffering", "no")
      .type("text/event-stream")
      .send(stream);
  });

  const routes = [
    { method: "GET", url: "/platform/strategy-authoring" },
    { method: "GET", url: "/platform/paper-news", timeout: 22000 },
    { method: "GET", url: "/platform/paper-market/:asset", timeout: 22000 },
    { method: "GET", url: "/platform/paper-watchlist" },
    { method: "PUT", url: "/platform/paper-watchlist/:asset" },
    { method: ["GET", "POST"], url: "/platform/paper-account" },
    { method: "POST", url: "/platform/paper-account/reset" },
    { method: "PUT", url: "/platform/paper-account/emergency" },
    { method: "GET", url: "/platform/paper-portfolio" },
    { method: ["GET", "POST"], url: "/platform/paper-orders" },
    { method: "POST", url: "/platform/paper-orders/:id/cancel" },
    { method: "POST", url: "/platform/paper-orders/:id/evaluate" },
    { method: ["GET", "POST"], url: "/platform/paper-agents" },
    { method: "POST", url: "/platform/paper-agents/:id/control" },
    { method: "POST", url: "/platform/paper-agents/:id/close-position" },
    { method: "GET", url: "/platform/paper-agents/:id/events" },
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
        const response = await forward(
          req.principal.userId,
          req.method,
          req.url,
          req.body,
          "timeout" in route ? route.timeout : 8000,
        );
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
