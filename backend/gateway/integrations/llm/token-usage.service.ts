import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Config } from "../../config.js";
import type { Principal } from "../../domain/schemas.js";
import { PlatformError } from "../../domain/errors.js";
import type { TenantStore } from "../../storage/tenant-store.js";
import type { LLMContext } from "./llm.interface.js";

interface Usage {
  tokens: number;
  reserved: number;
  requests: number;
}
export class TokenUsageService {
  constructor(
    private store: TenantStore,
    private config: Config,
  ) {}
  async reserve(context: LLMContext, maximum: number) {
    const p: Principal = { userId: context.userId, username: context.userId },
      day = new Date().toISOString().slice(0, 10),
      id = randomUUID();
    for (let attempt = 0; attempt < 4; attempt++) {
      const prior = await this.store.get<Usage>(p, "USAGE", day),
        data = prior?.data ?? { tokens: 0, reserved: 0, requests: 0 };
      if (
        data.tokens + data.reserved + maximum >
        this.config.KRONO_DAILY_TOKEN_LIMIT
      )
        throw new PlatformError(
          "USAGE_LIMIT",
          "Daily model token budget reached",
          429,
        );
      try {
        await this.store.commit(
          p,
          [
            {
              kind: "USAGE",
              id: day,
              expectedVersion: prior?.version ?? 0,
              data: {
                ...data,
                reserved: data.reserved + maximum,
                requests: data.requests + 1,
              },
            },
            {
              kind: "LLM_REQUEST",
              id,
              expectedVersion: 0,
              data: {
                ...context,
                modelId: this.config.BEDROCK_MODEL_ID,
                maximum,
                status: "RESERVED",
                day,
              },
            },
          ],
          "llm.reserved",
          { requestId: id },
        );
        return { id, day, maximum, p };
      } catch (e) {
        if ((e as { code?: string }).code !== "CONFLICT" || attempt === 3)
          throw e;
      }
    }
    throw Error("Usage reservation failed");
  }
  async finish(
    reservation: Awaited<ReturnType<TokenUsageService["reserve"]>>,
    result: {
      inputTokens?: number;
      outputTokens?: number;
      durationMs: number;
      status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
    },
  ) {
    const { p, id, day, maximum } = reservation;
    const known =
      result.inputTokens !== undefined && result.outputTokens !== undefined;
    const estimatedCostUsd =
      known &&
      this.config.KRONO_BEDROCK_INPUT_USD_PER_MILLION !== undefined &&
      this.config.KRONO_BEDROCK_OUTPUT_USD_PER_MILLION !== undefined
        ? new Decimal(result.inputTokens!)
            .mul(this.config.KRONO_BEDROCK_INPUT_USD_PER_MILLION)
            .add(
              new Decimal(result.outputTokens!).mul(
                this.config.KRONO_BEDROCK_OUTPUT_USD_PER_MILLION,
              ),
            )
            .div(1_000_000)
            .toFixed(8)
        : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const request = await this.store.get<Record<string, unknown>>(
        p,
        "LLM_REQUEST",
        id,
      );
      if (!request || request.data.status !== "RESERVED") return;
      const usage = await this.store.get<Usage>(p, "USAGE", day);
      if (!usage) throw Error("Missing usage reservation");
      // Timeouts retain the reservation: they may have been billed.
      const data = {
        ...usage.data,
        tokens:
          usage.data.tokens +
          (known ? result.inputTokens! + result.outputTokens! : 0),
        reserved: usage.data.reserved - (known ? maximum : 0),
      };
      try {
        await this.store.commit(
          p,
          [
            { kind: "USAGE", id: day, expectedVersion: usage.version, data },
            {
              kind: "LLM_REQUEST",
              id,
              expectedVersion: request.version,
              data: {
                ...request.data,
                ...result,
                estimatedCostUsd,
                pricingSource: this.config.KRONO_PRICING_SOURCE ?? null,
              },
            },
          ],
          "llm.completed",
          {
            requestId: id,
            status: result.status,
            durationMs: result.durationMs,
          },
        );
        return;
      } catch (e) {
        if ((e as { code?: string }).code !== "CONFLICT" || attempt === 4)
          throw e;
      }
    }
  }
}
