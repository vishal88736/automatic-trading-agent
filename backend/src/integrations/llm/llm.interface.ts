export interface ModelMessage {
  role: "user" | "assistant";
  content: Array<
    | { text: string }
    | { toolUse: { toolUseId: string; name: string; input: unknown } }
    | {
        toolResult: {
          toolUseId: string;
          content: Array<{ text: string }>;
          status?: "success" | "error";
        };
      }
  >;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface LLMContext {
  userId: string;
  sessionId: string;
  agentId?: string;
  requestId: string;
}
export interface LLMRequest {
  context: LLMContext;
  system: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  outputSchema?: { name: string; schema: Record<string, unknown> };
}
export interface LLMResponse {
  message: ModelMessage;
  stopReason: string;
  modelId: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  durationMs: number;
}
export interface LLMProvider {
  converse(request: LLMRequest): Promise<LLMResponse>;
}
