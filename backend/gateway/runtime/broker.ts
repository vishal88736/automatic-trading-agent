import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { idSchema, type Agent } from "../domain/schemas.js";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const pointerSchema = z
  .object({
    tenantId: idSchema,
    sourceAgentId: idSchema,
    opportunityId: idSchema,
  })
  .strict();
export async function handler(event: {
  Records: Array<{ messageId: string; body: string }>;
}) {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const message of event.Records) {
    try {
      const pointer = pointerSchema.safeParse(JSON.parse(message.body));
      if (!pointer.success) continue;
      const p = pointer.data,
        tenant = `TENANT#${p.tenantId}`,
        sourcePk = `${tenant}#AGENT#${p.sourceAgentId}`;
      // SQS payloads are untrusted pointers, never opportunities or authority.
      const [source, entry, control] = await Promise.all([
        db.send(
          new GetCommand({
            TableName: process.env.CONTROL_TABLE,
            Key: { pk: tenant, sk: `AGENT#${p.sourceAgentId}` },
            ConsistentRead: true,
          }),
        ),
        db.send(
          new GetCommand({
            TableName: process.env.RUNTIME_TABLE,
            Key: { pk: sourcePk, sk: `OPPORTUNITY#${p.opportunityId}` },
            ConsistentRead: true,
          }),
        ),
        db.send(
          new GetCommand({
            TableName: process.env.AGENT_CONTROL_TABLE,
            Key: { pk: sourcePk, sk: "CONTROL" },
            ConsistentRead: true,
          }),
        ),
      ]);
      const agent = source.Item?.data as Agent | undefined,
        op = entry.Item;
      if (
        !agent ||
        agent.ownerId !== p.tenantId ||
        !agent.specification.coordination.publishOpportunities ||
        agent.specification.type === "trading" ||
        !op ||
        op.deploymentId !== control.Item?.activeDeployment ||
        op.expiresAt < Date.now() / 1000
      )
        continue;
      let cursor: Record<string, unknown> | undefined;
      do {
        const targets = await db.send(
          new QueryCommand({
            TableName: process.env.CONTROL_TABLE,
            KeyConditionExpression: "pk=:pk AND begins_with(sk,:prefix)",
            ExpressionAttributeValues: { ":pk": tenant, ":prefix": "AGENT#" },
            ExclusiveStartKey: cursor,
            Limit: 100,
          }),
        );
        for (const row of targets.Items ?? []) {
          const target = row.data as Agent;
          if (
            target.ownerId !== p.tenantId ||
            target.state === "TERMINATED" ||
            target.specification.type !== "trading" ||
            !target.specification.coordination.researchAgentIds.includes(
              p.sourceAgentId,
            )
          )
            continue;
          try {
            await db.send(
              new PutCommand({
                TableName: process.env.RUNTIME_TABLE,
                Item: {
                  pk: `${tenant}#AGENT#${target.id}`,
                  sk: `INBOX#${p.opportunityId}`,
                  sourceAgentId: p.sourceAgentId,
                  opportunity: op.data,
                  expiresAt: op.expiresAt,
                  receivedAt: new Date().toISOString(),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              }),
            );
          } catch (e) {
            if ((e as Error).name !== "ConditionalCheckFailedException")
              throw e;
          }
        }
        cursor = targets.LastEvaluatedKey;
      } while (cursor);
    } catch {
      batchItemFailures.push({ itemIdentifier: message.messageId });
    }
  }
  return { batchItemFailures };
}
