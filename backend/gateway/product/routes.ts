import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { PlatformError } from "../domain/errors.js";
import { productClient, SERVICE_SUBJECT } from "./client.js";
import type { LLMProvider } from "../integrations/llm/llm.interface.js";
import {
  bedrockSchema,
  validateOutput,
} from "../integrations/llm/structured-output.js";

const objectiveSchema = z
  .object({
    objective: z.string().trim().min(1).max(2000),
    current_document: z.string().max(16000).optional(),
  })
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
  const forward = productClient(config);

  // Public, read-only live prices for every page, including the landing and sign-in.
  app.get("/platform/public/prices", async () => {
    const response = await forward(SERVICE_SUBJECT, "GET", "/platform/prices");
    if (!response.ok)
      throw new PlatformError(
        "MARKET_UNAVAILABLE",
        "Live prices are unavailable",
        503,
      );
    return response.json();
  });
  app.get("/platform/public/prices/stream", async (_req, reply) => {
    const response = await forward(
      SERVICE_SUBJECT,
      "GET",
      "/platform/prices/stream",
      undefined,
      150000,
    );
    if (!response.ok || !response.body)
      throw new PlatformError(
        "STREAM_UNAVAILABLE",
        "Live price stream unavailable",
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
    const { objective, current_document } = objectiveSchema.parse(req.body);
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
      system: `Translate the user's objective into an editable, long-only hourly paper strategy. When the request includes a current draft, use it as data and revise it according to the latest objective. Preserve rules the user did not ask to change. Return the strategy as a JSON string in strategy_json, matching this schema: ${JSON.stringify(schema)}. Use fractions (2% is 0.02), never invent an indicator or market. Explain defaults in notes. For unsupported or underspecified instructions, leave strategy_json empty and explain in notes. Return no forecasts. This drafts a document and cannot save it or place orders.`,
      messages: [
        {
          role: "user",
          content: [
            {
              text: current_document
                ? JSON.stringify({ objective, current_document })
                : objective,
            },
          ],
        },
      ],
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
  // Server-Sent Events pass through unbuffered; the product API bounds each session.
  for (const url of [
    "/platform/paper-agents/:id/stream",
    "/platform/news/stream",
  ])
    app.get(url, async (req, reply) => {
      const response = await forward(
        req.principal.userId,
        "GET",
        req.url,
        undefined,
        150000,
      );
      if (!response.ok || !response.body)
        throw new PlatformError(
          "STREAM_UNAVAILABLE",
          "Live stream unavailable",
          503,
        );
      const stream = Readable.fromWeb(
        response.body as unknown as ReadableStream,
      );
      reply.raw.once("close", () => stream.destroy());
      return reply
        .header("cache-control", "no-store")
        .header("x-accel-buffering", "no")
        .type("text/event-stream")
        .send(stream);
    });

  const routes = [
    { method: "GET", url: "/platform/strategy-authoring" },
    { method: "POST", url: "/platform/strategy-authoring/start-agent" },
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
    { method: "GET", url: "/platform/leaderboard" },
    { method: "GET", url: "/platform/news/live" },
    { method: "GET", url: "/platform/news/pulse", timeout: 45000 },
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
