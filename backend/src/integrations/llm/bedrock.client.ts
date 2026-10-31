import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { Config } from "../../config.js";

// The SDK default credential chain uses task roles/SSO/temporary credentials.
export function createBedrockClient(config: Config) {
  return new BedrockRuntimeClient({
    region: config.AWS_REGION,
    // Retries are explicit in the provider so every potentially billed attempt is reserved.
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: 5000,
      requestTimeout: config.BEDROCK_TIMEOUT_MS,
    },
  });
}
