import { z } from "zod";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Principal, Agent } from "../../domain/schemas.js";
import { idSchema, strategyId } from "../../domain/schemas.js";
import type { Config } from "../../config.js";
import type { TenantStore } from "../../storage/tenant-store.js";
import { runtimeKey } from "../../storage/tenant-store.js";
import type { LLMProvider } from "./llm.interface.js";
import { bedrockSchema, validateOutput } from "./structured-output.js";
import { DEFAULT_PROMPT } from "./prompt-manager.js";

export const analysisPointer = z
  .object({ tenantId: idSchema, agentId: idSchema, requestId: idSchema })
  .strict();
const reviewSchema = z
  .object({
    summary: z.string().max(2500),
    preferredStrategy: strategyId.nullable(),
    veto: z.boolean(),
    evidenceRefs: z.array(z.string().max(250)).max(20),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export class AgentAnalysisService {
  constructor(
    private c: Config,
    private store: TenantStore,
    private db: DynamoDBDocumentClient,
    private llm: LLMProvider,
  ) {}
  async process(raw: unknown) {
    const pointer = analysisPointer.parse(raw),
      p: Principal = { userId: pointer.tenantId, username: pointer.tenantId },
      pk = runtimeKey(p, pointer.agentId);
    const [row, request, control] = await Promise.all([
      this.store.get<Agent>(p, "AGENT", pointer.agentId),
      this.db.send(
        new GetCommand({
          TableName: this.c.KRONO_RUNTIME_TABLE,
          Key: { pk, sk: `ANALYSIS_REQUEST#${pointer.requestId}` },
          ConsistentRead: true,
        }),
      ),
      this.db.send(
        new GetCommand({
          TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
          Key: { pk, sk: "CONTROL" },
          ConsistentRead: true,
        }),
      ),
    ]);
    const packet = request.Item;
    if (
      !row ||
      row.data.ownerId !== p.userId ||
      row.data.state === "TERMINATED" ||
      !packet ||
      !row.data.deployment ||
      row.data.deployment.id !== packet.deploymentId ||
      packet.deploymentId !== control.Item?.activeDeployment ||
      packet.expiresAt < Date.now() / 1000
    )
      return { status: "SKIPPED" };
    if (
      !row.data.specification.configuration.assets.includes(packet.data.symbol)
    )
      return { status: "SKIPPED" };
    const jobId = `${pointer.agentId}:${pointer.requestId}`;
    if (await this.store.get(p, "ANALYSIS", jobId))
      return { status: "ALREADY_RECORDED" };
    try {
      await this.store.commit(
        p,
        [
          {
            kind: "ANALYSIS",
            id: jobId,
            expectedVersion: 0,
            data: {
              status: "RUNNING",
              agentId: pointer.agentId,
              requestId: pointer.requestId,
            },
          },
        ],
        "agent.model_review.started",
        { agentId: pointer.agentId, requestId: pointer.requestId },
      );
    } catch (e) {
      if ((e as { code?: string }).code === "CONFLICT")
        return { status: "ALREADY_RECORDED" };
      throw e;
    }
    let data: Record<string, unknown>;
    try {
      const result = await this.llm.converse({
        context: {
          userId: p.userId,
          agentId: pointer.agentId,
          sessionId: pointer.agentId,
          requestId: pointer.requestId,
        },
        system: `${DEFAULT_PROMPT}\nReview the measured market features, news and deterministic strategy rankings. Only eligible enabled strategies may be recommended. Give a concise public rationale and use evidence references present in the packet. You cannot set size, authorize a trade, change risk or close positions. Missing evidence must be stated.`,
        messages: [
          {
            role: "user",
            content: [{ text: JSON.stringify(packet.data).slice(0, 30000) }],
          },
        ],
        outputSchema: {
          name: "strategy_review",
          schema: bedrockSchema(reviewSchema),
        },
      });
      const text = result.message.content
        .flatMap((c) => ("text" in c ? [c.text] : []))
        .join("");
      const review = validateOutput(reviewSchema, JSON.parse(text));
      const eligible = new Set(
        (
          packet.data.rankings as Array<{
            eligible: boolean;
            strategy_id: string;
          }>
        )
          .filter((r) => r.eligible)
          .map((r) => r.strategy_id),
      );
      const evidence = new Set<string>(packet.data.evidenceRefs);
      if (review.preferredStrategy && !eligible.has(review.preferredStrategy))
        throw Error("Ineligible model recommendation");
      if (review.evidenceRefs.some((ref) => !evidence.has(ref)))
        throw Error("Unsupported model evidence");
      const advice = {
        ...review,
        symbol: packet.data.symbol,
        marketSource: packet.data.marketSource,
        marketAsOf: packet.data.marketAsOf,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        requestId: pointer.requestId,
        modelId: result.modelId,
      };
      await this.db.send(
        new UpdateCommand({
          TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
          Key: { pk, sk: "CONTROL" },
          UpdateExpression: "SET adviceByAsset.#asset=:advice",
          ExpressionAttributeNames: { "#asset": packet.data.symbol },
          ConditionExpression: "activeDeployment=:deployment",
          ExpressionAttributeValues: {
            ":advice": advice,
            ":deployment": packet.deploymentId,
          },
        }),
      );
      data = {
        status: "COMPLETED",
        advice,
        agentId: pointer.agentId,
        usage: result.usage,
        durationMs: result.durationMs,
      };
    } catch (e) {
      data = {
        status: "FAILED",
        agentId: pointer.agentId,
        errorType: (e as Error).name,
        reason:
          "Model review unavailable or rejected by structured evidence validation. No permission or risk setting changed.",
      };
    }
    const prior = await this.store.get(p, "ANALYSIS", jobId);
    await this.store.commit(
      p,
      [{ kind: "ANALYSIS", id: jobId, expectedVersion: prior!.version, data }],
      "agent.model_review.completed",
      { agentId: pointer.agentId, status: data.status },
    );
    return data;
  }
}
