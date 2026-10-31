import { App } from "aws-cdk-lib";
import { KronoStack } from "./stack.js";
import { runtimeSettingsSchema } from "../backend/src/config.js";
const app = new App();
const stage = process.env.KRONO_ENV ?? "development";
if (!["development", "staging", "production"].includes(stage))
  throw Error("Invalid KRONO_ENV");
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
