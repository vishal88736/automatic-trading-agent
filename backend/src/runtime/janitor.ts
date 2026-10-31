import {
  ECSClient,
  ListServicesCommand,
  DescribeServicesCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
const ecs = new ECSClient({}),
  db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
/** Independent of agent processes and user sessions. A crash cannot extend a runtime budget. */
export async function handler() {
  const cluster = process.env.CLUSTER!,
    table = process.env.RUNTIME_TABLE!,
    now = Date.now() / 1000;
  let nextToken: string | undefined,
    stopped = 0;
  do {
    const page = await ecs.send(
      new ListServicesCommand({ cluster, nextToken, maxResults: 100 }),
    );
    for (
      let offset = 0;
      offset < (page.serviceArns?.length ?? 0);
      offset += 10
    ) {
      const r = await ecs.send(
        new DescribeServicesCommand({
          cluster,
          services: page.serviceArns!.slice(offset, offset + 10),
          include: ["TAGS"],
        }),
      );
      for (const s of r.services ?? []) {
        const tags = Object.fromEntries(
          (s.tags ?? []).map((t) => [t.key, t.value]),
        );
        if (
          !tags.KronoAgent ||
          !tags.KronoTenant ||
          !tags.KronoDeployment ||
          !s.desiredCount
        )
          continue;
        const expired = Number(tags.KronoExpiresAt) <= now;
        const h = await db.send(
          new GetCommand({
            TableName: table,
            Key: {
              pk: `TENANT#${tags.KronoTenant}#AGENT#${tags.KronoAgent}`,
              sk: `HEARTBEAT#${tags.KronoDeployment}`,
            },
            ConsistentRead: true,
          }),
        );
        if (expired || ["STOPPED", "FAILED"].includes(h.Item?.status)) {
          await ecs.send(
            new UpdateServiceCommand({
              cluster,
              service: s.serviceArn!,
              desiredCount: 0,
            }),
          );
          stopped++;
        }
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  console.log(JSON.stringify({ event: "runtime.budget_sweep", stopped }));
  return { stopped };
}
