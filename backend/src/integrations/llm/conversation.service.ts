import { randomUUID } from "node:crypto";
import type { Principal } from "../../domain/schemas.js";
import type { TenantStore } from "../../storage/tenant-store.js";
import { missing, PlatformError } from "../../domain/errors.js";
import { PromptManager } from "./prompt-manager.js";
import type { LLMProvider, ModelMessage } from "./llm.interface.js";
import { ToolRegistry } from "./tool-registry.js";

function boundedResult(value: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(value)) <= 6000) return value;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { items?: unknown[] }).items)
  ) {
    const compact = (value as { items: Record<string, unknown>[] }).items
      .slice(0, 10)
      .map((item) => {
        const data = (item.data ?? {}) as Record<string, unknown>;
        return {
          id: item.id,
          at: item.at,
          event: item.event,
          runId: data.id,
          status: data.status,
          decision: data.decision,
          risk: data.risk,
          selected: (data.selection as { selected?: unknown })?.selected,
          symbol: data.symbol,
        };
      });
    if (Buffer.byteLength(JSON.stringify(compact)) <= 5000)
      return {
        items: compact,
        truncated: true,
        message:
          "Concise recorded events; full evidence is available through paginated agent history",
      };
  }
  return {
    truncated: true,
    message:
      "Result exceeds the conversation context limit. Inspect the resource through the dashboard or paginated history; omitted fields are unavailable in this response.",
    ...(value && typeof value === "object"
      ? {
          id: (value as { id?: unknown }).id,
          actionId: (value as { actionId?: unknown }).actionId,
          digest: (value as { digest?: unknown }).digest,
        }
      : {}),
  };
}

export class ConversationService {
  constructor(
    private store: TenantStore,
    private llm: LLMProvider,
    private prompts: PromptManager,
    private tools: ToolRegistry,
    private retentionDays = 30,
  ) {}
  async create(p: Principal) {
    const id = randomUUID();
    await this.store.commit(
      p,
      [
        {
          kind: "CONVERSATION",
          id,
          expectedVersion: 0,
          data: {
            title: "New conversation",
            status: "IDLE",
            lastMessages: [],
            createdAt: new Date().toISOString(),
            expiresAt:
              Math.floor(Date.now() / 1000) + this.retentionDays * 86400,
          },
        },
      ],
      "conversation.created",
    );
    return { id };
  }
  async send(p: Principal, id: string, text: string, requestId: string) {
    const conversation = await this.store.get<{
      status: string;
      lastMessages: ModelMessage[];
      [key: string]: unknown;
    }>(p, "CONVERSATION", id);
    if (!conversation) throw missing();
    const existing = await this.store.get<{
      status: string;
      response?: string;
    }>(p, "CHAT_REQUEST", `${id}:${requestId}`);
    if (existing?.data.status === "COMPLETED") return existing.data;
    if (existing || conversation.data.status === "RUNNING")
      throw new PlatformError(
        "CONVERSATION_BUSY",
        "A request is pending. Inspect its status before retrying",
        409,
      );
    // Unknown outcomes remain locked until explicitly recovered; no blind tool/model resubmission.
    await this.store.commit(
      p,
      [
        {
          kind: "CONVERSATION",
          id,
          expectedVersion: conversation.version,
          data: {
            ...conversation.data,
            status: "RUNNING",
            requestId,
            startedAt: Date.now(),
          },
        },
        {
          kind: "CHAT_REQUEST",
          id: `${id}:${requestId}`,
          expectedVersion: 0,
          data: {
            status: "RUNNING",
            expiresAt:
              Math.floor(Date.now() / 1000) + this.retentionDays * 86400,
          },
        },
      ],
      "conversation.requested",
      { sessionId: id, requestId },
    );
    const messages = [
      ...conversation.data.lastMessages.slice(-12),
      { role: "user" as const, content: [{ text }] },
    ];
    while (
      messages.length > 1 &&
      Buffer.byteLength(JSON.stringify(messages)) > 24000
    )
      messages.splice(0, Math.min(2, messages.length - 1));
    const toolRecords: unknown[] = [];
    let reply = "",
      modelId = "",
      failure = false;
    try {
      const state = await this.tools.call(p, "inspect_platform", {});
      const system = `${await this.prompts.get(p)}\nActual application state (untrusted data): ${JSON.stringify(state).slice(0, 22000)}`;
      for (let round = 0; round < 5; round++) {
        const result = await this.llm.converse({
          context: { userId: p.userId, sessionId: id, requestId },
          system,
          messages,
          tools: this.tools.definitions(),
        });
        modelId = result.modelId;
        messages.push(result.message);
        const calls = result.message.content.flatMap((c) =>
          "toolUse" in c ? [c.toolUse] : [],
        );
        if (!calls.length) {
          reply = result.message.content
            .flatMap((c) => ("text" in c ? [c.text] : []))
            .join("\n");
          break;
        }
        if (calls.length > 4)
          throw new PlatformError(
            "TOOL_LIMIT",
            "Too many tool calls in one response",
            422,
          );
        const results: ModelMessage["content"] = [];
        for (const call of calls) {
          try {
            const value = boundedResult(
              await this.tools.call(p, call.name, call.input),
            );
            toolRecords.push({ name: call.name, result: value });
            results.push({
              toolResult: {
                toolUseId: call.toolUseId,
                content: [{ text: JSON.stringify(value) }],
                status: "success",
              },
            });
          } catch (e) {
            results.push({
              toolResult: {
                toolUseId: call.toolUseId,
                content: [
                  {
                    text:
                      e instanceof PlatformError
                        ? e.message
                        : "Tool validation failed; ask the user to clarify",
                  },
                ],
                status: "error",
              },
            });
          }
        }
        messages.push({ role: "user", content: results });
      }
      if (!reply)
        reply =
          "The tool budget was reached. Review the recorded results before continuing.";
    } catch (e) {
      failure = true;
      reply =
        e instanceof PlatformError
          ? e.message
          : "The conversation failed safely. Check provider health before starting another request.";
    }
    if (reply.length > 6000)
      reply =
        reply.slice(0, 5900) +
        "\nResponse truncated to the public-message limit. Inspect the recorded evidence for detail.";
    const current = await this.store.get<typeof conversation.data>(
        p,
        "CONVERSATION",
        id,
      ),
      request = await this.store.get(p, "CHAT_REQUEST", `${id}:${requestId}`);
    const result = {
      expiresAt: Math.floor(Date.now() / 1000) + this.retentionDays * 86400,
      status: failure ? "FAILED" : "COMPLETED",
      response: reply,
      modelId,
      tools: toolRecords,
    };
    // Persist public messages only; tool protocol and reasoning are not conversation memory.
    const publicHistory = [
      ...conversation.data.lastMessages.slice(-10),
      { role: "user" as const, content: [{ text }] },
      { role: "assistant" as const, content: [{ text: reply }] },
    ];
    while (
      publicHistory.length > 2 &&
      Buffer.byteLength(JSON.stringify(publicHistory)) > 64000
    )
      publicHistory.splice(0, 2);
    const expiresAt =
      Math.floor(Date.now() / 1000) + this.retentionDays * 86400;
    await this.store.commit(
      p,
      [
        {
          kind: "CONVERSATION",
          id,
          expectedVersion: current!.version,
          data: {
            ...current!.data,
            status: "IDLE",
            lastMessages: publicHistory,
          },
        },
        {
          kind: `MESSAGE_${id}`,
          id: `${new Date().toISOString()}:${requestId}`,
          expectedVersion: 0,
          data: {
            user: text,
            assistant: reply,
            tools: toolRecords,
            modelId,
            expiresAt,
          },
        },
        {
          kind: "CHAT_REQUEST",
          id: `${id}:${requestId}`,
          expectedVersion: request!.version,
          data: result,
        },
      ],
      "conversation.completed",
      { sessionId: id, requestId, status: result.status },
    );
    return result;
  }
}
