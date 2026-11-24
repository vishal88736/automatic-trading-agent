import { App } from "aws-cdk-lib";
import { KronoStack } from "./stack.js";
import { runtimeSettingsSchema } from "../backend/gateway/config.js";
const app = new App();
const stage = process.env.KRONO_ENV ?? "development";
const llmProvider = process.env.KRONO_LLM_PROVIDER || "bedrock";
if (!["development", "staging", "production"].includes(stage))
  throw Error("Invalid KRONO_ENV");
if (
  llmProvider !== "bedrock" &&
  llmProvider !== "groq" &&
  llmProvider !== "rules"
)
  throw Error("Invalid KRONO_LLM_PROVIDER");
new KronoStack(app, `krono-${stage}`, {
  stage: stage as "development" | "staging" | "production",
  env: {
    account:
      process.env.AWS_ACCOUNT_ID ||
      process.env.CDK_DEFAULT_ACCOUNT ||
      undefined,
    region: process.env.AWS_REGION ?? "ap-south-1",
  },
  domainName: process.env.KRONO_DOMAIN_NAME,
  hostedZoneId: process.env.KRONO_HOSTED_ZONE_ID,
  hostedZoneName: process.env.KRONO_HOSTED_ZONE_NAME,
  cloudFrontCertificateArn: process.env.KRONO_CLOUDFRONT_CERTIFICATE_ARN,
  budgetUsd: process.env.KRONO_MONTHLY_BUDGET_USD
    ? Number(process.env.KRONO_MONTHLY_BUDGET_USD)
    : undefined,
  budgetEmail: process.env.KRONO_BUDGET_EMAIL,
  apiImageDigest: process.env.KRONO_API_IMAGE_DIGEST || undefined,
  agentImageDigest: process.env.KRONO_AGENT_IMAGE_DIGEST || undefined,
  productImageDigest: process.env.KRONO_PRODUCT_IMAGE_DIGEST || undefined,
  credentialKeyArn: process.env.KRONO_CREDENTIAL_KEY_SECRET_ARN || undefined,
  egressHosts: process.env.KRONO_AWS_EXTRA_EGRESS_HOSTS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  groqKeyArn: process.env.KRONO_GROQ_KEY_SECRET_ARN || undefined,
  groqBaseUrl: process.env.GROQ_BASE_URL || undefined,
  groqModel: process.env.GROQ_MODEL || undefined,
  llmProvider,
  wafRateLimit: process.env.KRONO_WAF_RATE_LIMIT
    ? Number(process.env.KRONO_WAF_RATE_LIMIT)
    : undefined,
  githubRepository: process.env.KRONO_GITHUB_REPOSITORY,
  githubOidcProviderArn: process.env.KRONO_GITHUB_OIDC_PROVIDER_ARN,
  modelId: process.env.BEDROCK_MODEL_ID,
  runtimeSettings: Object.fromEntries(
    Object.entries(runtimeSettingsSchema.parse(process.env))
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  ),
});
app.synth();
