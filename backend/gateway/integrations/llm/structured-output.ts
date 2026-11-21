import { z } from "zod";
import { PlatformError } from "../../domain/errors.js";
export function validateOutput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new PlatformError(
      "INVALID_MODEL_OUTPUT",
      "The model returned an invalid structured result",
      422,
    );
  return parsed.data;
}
/** Bedrock subset; full financial bounds are still enforced by Zod on the server. */
export function bedrockSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { unrepresentable: "any" });
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>,
      names = (record.propertyNames as { enum?: string[] } | undefined)?.enum;
    if (
      names &&
      record.additionalProperties &&
      typeof record.additionalProperties === "object"
    ) {
      const expanded: Record<string, unknown> = {
        ...record,
        properties: Object.fromEntries(
          names.map((name) => [name, record.additionalProperties]),
        ),
        additionalProperties: false,
      };
      delete expanded.propertyNames;
      return clean(expanded);
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            ![
              "$schema",
              "minimum",
              "maximum",
              "exclusiveMinimum",
              "exclusiveMaximum",
              "minLength",
              "maxLength",
              "pattern",
              "format",
              "default",
              "maxItems",
              "uniqueItems",
            ].includes(k),
        )
        .map(([k, v]) => [
          k,
          k === "minItems" ? Math.min(1, Number(v)) : clean(v),
        ]),
    );
  };
  return clean(raw) as Record<string, unknown>;
}
