import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/)
    .default("ap-south-1"),
  KRONO_ENV: z
    .enum(["development", "staging", "production"])
    .default("development"),
  KRONO_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  KRONO_HOST: z.string().default("127.0.0.1"),
  KRONO_PUBLIC_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
  // "local" signs users in against the product database instead of Cognito and needs no AWS.
  KRONO_AUTH_MODE: z.enum(["cognito", "local"]).default("cognito"),
  KRONO_SESSION_SECRET: z.string().min(32).optional(),
  COGNITO_USER_POOL_ID: z.string().min(8),
  COGNITO_CLIENT_ID: z.string().min(8),
  KRONO_CONTROL_TABLE: z.string().min(3),
  KRONO_RUNTIME_TABLE: z.string().min(3),
  KRONO_AGENT_CONTROL_TABLE: z.string().min(3),
  KRONO_ARTIFACT_BUCKET: z.string().min(3),
  KRONO_CLUSTER_ARN: z.string().min(8),
  KRONO_DEPLOYMENT_WORKFLOW_ARN: z.string().min(8),
  KRONO_PROVISIONER_ROLE_ARN: z.string().min(8),
  KRONO_TASK_EXECUTION_ROLE_ARN: z.string().min(8),
  KRONO_AGENT_BOUNDARY_ARN: z.string().min(8),
  KRONO_AGENT_IMAGE: z
    .string()
    .regex(
      /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[^\s]+@sha256:[a-f0-9]{64}$/,
    ),
  KRONO_PRIVATE_SUBNETS: z.string().min(3),
  KRONO_AGENT_SECURITY_GROUP: z.string().min(3),
  KRONO_RUNTIME_KMS_ARN: z.string().min(8),
  KRONO_AGENT_LOG_GROUP: z.string().min(3),
  KRONO_COORDINATION_QUEUE_URL: z.string().url(),
  KRONO_ANALYSIS_QUEUE_URL: z.string().url().optional(),
  KRONO_PRODUCT_API_URL: z.string().url().optional(),
  KRONO_PRODUCT_API_KEY: z.string().min(32).optional(),
  // Model backend for platform conversations: Bedrock (MiniMax) or Groq's OpenAI-compatible API.
  // GROQ_* also accepts any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama).
  // "rules" drafts strategies with the built-in parser and needs no model key.
  KRONO_LLM_PROVIDER: z.enum(["bedrock", "groq", "rules"]).default("bedrock"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().min(3).default("openai/gpt-oss-120b"),
  GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  BEDROCK_MODEL_ID: z.string().min(3).default("minimax.minimax-m2.5"),
  BEDROCK_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(128)
    .max(8192)
    .default(2048),
  BEDROCK_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),
  BEDROCK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(180000)
    .default(120000),
  BEDROCK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(2),
  KRONO_MAX_AGENTS_PER_USER: z.coerce.number().int().min(1).max(20).default(3),
  KRONO_MAX_AGENT_SPECS_PER_USER: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20),
  KRONO_DAILY_TOKEN_LIMIT: z.coerce
    .number()
    .int()
    .min(1000)
    .max(10000000)
    .default(100000),
  KRONO_DAILY_RUNTIME_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(864000)
    .default(14400),
  KRONO_MESSAGE_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30),
  KRONO_BEDROCK_INPUT_USD_PER_MILLION: z.coerce
    .number()
    .nonnegative()
    .optional(),
  KRONO_BEDROCK_OUTPUT_USD_PER_MILLION: z.coerce
    .number()
    .nonnegative()
    .optional(),
  KRONO_PRICING_SOURCE: z.string().url().optional(),
});
export type Config = z.infer<typeof envSchema>;
export const runtimeSettingsSchema = envSchema.pick({
  BEDROCK_MAX_OUTPUT_TOKENS: true,
  BEDROCK_TEMPERATURE: true,
  BEDROCK_TIMEOUT_MS: true,
  BEDROCK_MAX_ATTEMPTS: true,
  KRONO_MAX_AGENTS_PER_USER: true,
  KRONO_MAX_AGENT_SPECS_PER_USER: true,
  KRONO_DAILY_TOKEN_LIMIT: true,
  KRONO_DAILY_RUNTIME_SECONDS: true,
  KRONO_MESSAGE_RETENTION_DAYS: true,
  KRONO_BEDROCK_INPUT_USD_PER_MILLION: true,
  KRONO_BEDROCK_OUTPUT_USD_PER_MILLION: true,
  KRONO_PRICING_SOURCE: true,
});
// Local mode never calls AWS. These inert values satisfy the shared AWS field shapes so the
// Cognito deployment keeps its strict validation without a second config type.
const localAwsPlaceholders = {
  COGNITO_USER_POOL_ID: "local-unused",
  COGNITO_CLIENT_ID: "local-unused",
  KRONO_CONTROL_TABLE: "local-unused",
  KRONO_RUNTIME_TABLE: "local-unused",
  KRONO_AGENT_CONTROL_TABLE: "local-unused",
  KRONO_ARTIFACT_BUCKET: "local-unused",
  KRONO_CLUSTER_ARN: "local-unused",
  KRONO_DEPLOYMENT_WORKFLOW_ARN: "local-unused",
  KRONO_PROVISIONER_ROLE_ARN: "local-unused",
  KRONO_TASK_EXECUTION_ROLE_ARN: "local-unused",
  KRONO_AGENT_BOUNDARY_ARN: "local-unused",
  KRONO_AGENT_IMAGE: `000000000000.dkr.ecr.local-unused-1.amazonaws.com/unused@sha256:${"0".repeat(64)}`,
  KRONO_PRIVATE_SUBNETS: "local-unused",
  KRONO_AGENT_SECURITY_GROUP: "local-unused",
  KRONO_RUNTIME_KMS_ARN: "local-unused",
  KRONO_AGENT_LOG_GROUP: "local-unused",
  KRONO_COORDINATION_QUEUE_URL: "http://127.0.0.1/unused",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const local = env.KRONO_AUTH_MODE === "local";
  const result = envSchema.safeParse(
    local ? { ...localAwsPlaceholders, ...env } : env,
  );
  if (!result.success)
    throw new Error(
      `Missing or invalid platform environment fields: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const c = result.data;
  if (
    c.NODE_ENV === "production" &&
    !c.KRONO_PUBLIC_ORIGIN.startsWith("https://")
  )
    throw Error("Production requires HTTPS");
  if (
    (c.KRONO_BEDROCK_INPUT_USD_PER_MILLION !== undefined ||
      c.KRONO_BEDROCK_OUTPUT_USD_PER_MILLION !== undefined) &&
    !c.KRONO_PRICING_SOURCE
  )
    throw Error("Cost estimates require a documented pricing source");
  if (local && !c.KRONO_PRODUCT_API_URL)
    throw Error("Local sign-in stores accounts through the product API");
  if (local && c.NODE_ENV === "production" && !c.KRONO_SESSION_SECRET)
    throw Error("Production local sign-in requires KRONO_SESSION_SECRET");
  if (Boolean(c.KRONO_PRODUCT_API_URL) !== Boolean(c.KRONO_PRODUCT_API_KEY))
    throw Error("Configure the product API URL and key together");
  if (c.KRONO_PRODUCT_API_URL) {
    const url = new URL(c.KRONO_PRODUCT_API_URL);
    const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && local && c.NODE_ENV !== "production")) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw Error(
        "Use an HTTPS product API origin or loopback HTTP in development",
      );
  }
  return c;
}
