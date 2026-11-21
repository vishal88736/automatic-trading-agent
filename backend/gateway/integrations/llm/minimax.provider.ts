import {
  ConverseCommand,
  type BedrockRuntimeClient,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import type { Config } from "../../config.js";
import { PlatformError } from "../../domain/errors.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ModelMessage,
} from "./llm.interface.js";
import { TokenUsageService } from "./token-usage.service.js";
export class MiniMaxProvider implements LLMProvider {
  constructor(
    private client: BedrockRuntimeClient,
    private config: Config,
    private usage: TokenUsageService,
  ) {}
  async converse(request: LLMRequest): Promise<LLMResponse> {
    for (
      let attempt = 0;
      attempt < this.config.BEDROCK_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        return await this.invoke(request);
      } catch (e) {
        if (
          !(e instanceof PlatformError) ||
          e.code !== "MODEL_THROTTLED" ||
          attempt + 1 >= this.config.BEDROCK_MAX_ATTEMPTS
        )
          throw e;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw new PlatformError(
      "MODEL_UNAVAILABLE",
      "Bedrock retry limit reached",
      503,
    );
  }
  private async invoke(request: LLMRequest): Promise<LLMResponse> {
    const bytes = Buffer.byteLength(
      JSON.stringify({
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        outputSchema: request.outputSchema,
      }),
    );
    if (bytes > 80_000)
      throw new PlatformError(
        "CONTEXT_LIMIT",
        "Conversation context is too large",
        413,
      );
    const reservation = await this.usage.reserve(
        request.context,
        bytes + 2048 + this.config.BEDROCK_MAX_OUTPUT_TOKENS,
      ),
      started = Date.now();
    let recorded = false;
    try {
      const response = await this.client.send(
        new ConverseCommand({
          modelId: this.config.BEDROCK_MODEL_ID,
          system: [{ text: request.system }],
          messages: request.messages as Message[],
          inferenceConfig: {
            maxTokens: this.config.BEDROCK_MAX_OUTPUT_TOKENS,
            temperature: this.config.BEDROCK_TEMPERATURE,
          },
          ...(request.tools?.length
            ? {
                toolConfig: {
                  tools: request.tools.map((t) => ({
                    toolSpec: {
                      name: t.name,
                      description: t.description,
                      inputSchema: {
                        json: JSON.parse(JSON.stringify(t.inputSchema)),
                      },
                      strict: true,
                    },
                  })),
                },
              }
            : {}),
          ...(request.outputSchema
            ? {
                outputConfig: {
                  textFormat: {
                    type: "json_schema",
                    structure: {
                      jsonSchema: {
                        name: request.outputSchema.name,
                        schema: JSON.stringify(request.outputSchema.schema),
                      },
                    },
                  },
                },
              }
            : {}),
        }),
        { abortSignal: AbortSignal.timeout(this.config.BEDROCK_TIMEOUT_MS) },
      );
      const content: ModelMessage["content"] = [];
      for (const b of response.output?.message?.content ?? []) {
        if (b.text) content.push({ text: b.text });
        if (b.toolUse?.toolUseId && b.toolUse.name)
          content.push({
            toolUse: {
              toolUseId: b.toolUse.toolUseId,
              name: b.toolUse.name,
              input: b.toolUse.input,
            },
          });
      }
      const u = response.usage,
        durationMs = Date.now() - started;
      await this.usage.finish(reservation, {
        inputTokens: u?.inputTokens,
        outputTokens: u?.outputTokens,
        durationMs,
        status: "SUCCEEDED",
      });
      recorded = true;
      if (!content.length)
        throw new PlatformError(
          "EMPTY_MODEL_OUTPUT",
          "The model returned no public result",
          502,
        );
      return {
        message: { role: "assistant", content },
        stopReason: response.stopReason ?? "unknown",
        usage: {
          inputTokens: u?.inputTokens ?? null,
          outputTokens: u?.outputTokens ?? null,
        },
        modelId: this.config.BEDROCK_MODEL_ID,
        durationMs,
      };
    } catch (e) {
      if (!recorded)
        await this.usage.finish(reservation, {
          durationMs: Date.now() - started,
          status: "UNKNOWN",
        });
      if (e instanceof PlatformError) throw e;
      if (
        ["ThrottlingException", "ModelNotReadyException"].includes(
          (e as Error).name,
        )
      )
        throw new PlatformError(
          "MODEL_THROTTLED",
          "Bedrock is throttled or the model is not ready",
          503,
        );
      throw new PlatformError(
        "MODEL_UNAVAILABLE",
        "Bedrock request failed; verify model access, region and account quotas",
        503,
      );
    }
  }
}
