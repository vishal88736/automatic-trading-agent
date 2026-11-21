import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
} from "@aws-sdk/client-sfn";
import {
  ECSClient,
  DescribeServicesCommand,
  UpdateServiceCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DeleteStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch";
import type { Config } from "../config.js";
import type {
  Agent,
  AgentSpec,
  Deployment,
  Principal,
} from "../domain/schemas.js";
import { conflict, denied } from "../domain/errors.js";
import { runtimeKey } from "../storage/tenant-store.js";
import { agentTemplate } from "./agent-template.js";
import type { RuntimeProvider, RuntimeStatus } from "./runtime.interface.js";
const clientConfig = (region: string) => ({
  region,
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
});

export class AwsRuntime implements RuntimeProvider {
  constructor(
    private c: Config,
    private db: DynamoDBDocumentClient,
    private sfn = new SFNClient(clientConfig(c.AWS_REGION)),
    // A restart has no idempotency token; do not retry an uncertain mutation in the SDK.
    private ecs = new ECSClient({
      ...clientConfig(c.AWS_REGION),
      maxAttempts: 1,
    }),
    private cf = new CloudFormationClient(clientConfig(c.AWS_REGION)),
    private cw = new CloudWatchClient(clientConfig(c.AWS_REGION)),
    private logsClient = new CloudWatchLogsClient(clientConfig(c.AWS_REGION)),
  ) {}
  async tenantPolicy(p: Principal) {
    const r = await this.db.send(
      new GetCommand({
        TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
        Key: { pk: `TENANT#${p.userId}#POLICY`, sk: "CONTROL" },
        ConsistentRead: true,
      }),
    );
    return {
      emergency: !!r.Item?.emergency,
      version: Number(r.Item?.version ?? 0),
    };
  }
  async setEmergency(p: Principal, active: boolean, expectedVersion?: number) {
    const current = await this.tenantPolicy(p);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw conflict();
    await this.db.send(
      new PutCommand({
        TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
        Item: {
          pk: `TENANT#${p.userId}#POLICY`,
          sk: "CONTROL",
          emergency: active,
          version: current.version + 1,
        },
        ConditionExpression: current.version
          ? "#v=:v"
          : "attribute_not_exists(pk)",
        ...(current.version
          ? {
              ExpressionAttributeNames: { "#v": "version" },
              ExpressionAttributeValues: { ":v": current.version },
            }
          : {}),
      }),
    );
    return { emergency: active, version: current.version + 1 };
  }
  private key(p: Principal, a: Agent) {
    if (a.ownerId !== p.userId) throw denied();
    return { pk: runtimeKey(p, a.id), sk: "CONTROL" };
  }
  async prepare(p: Principal, a: Agent, spec: AgentSpec, d: Deployment) {
    const key = this.key(p, a);
    const current = await this.db.send(
      new GetCommand({
        TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
        Key: key,
        ConsistentRead: true,
      }),
    );
    if (
      current.Item?.candidateDeployment === d.id ||
      current.Item?.activeDeployment === d.id
    )
      return;
    await this.db.send(
      new PutCommand({
        TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
        Item: {
          ...key,
          activeDeployment: current.Item?.activeDeployment ?? null,
          activeSpec: current.Item?.activeSpec ?? null,
          expiresAt: current.Item?.expiresAt ?? d.expiresAt,
          desired: current.Item?.activeDeployment ? "PAUSE" : "RUN",
          candidateActivationDesired: "RUN",
          candidateDeployment: d.id,
          candidateSpec: spec,
          adviceByAsset: {},
          candidateExpiresAt: d.expiresAt,
          version: (current.Item?.version ?? 0) + 1,
        },
        ConditionExpression: current.Item
          ? "#v=:v"
          : "attribute_not_exists(pk)",
        ...(current.Item
          ? {
              ExpressionAttributeNames: { "#v": "version" },
              ExpressionAttributeValues: { ":v": current.Item.version },
            }
          : {}),
      }),
    );
  }
  async deploy(p: Principal, a: Agent, d: Deployment) {
    this.key(p, a);
    const name = `deploy-${d.id}`,
      workflowArn =
        this.c.KRONO_DEPLOYMENT_WORKFLOW_ARN.replace(
          ":stateMachine:",
          ":execution:",
        ) + `:${name}`;
    try {
      const r = await this.sfn.send(
        new StartExecutionCommand({
          stateMachineArn: this.c.KRONO_DEPLOYMENT_WORKFLOW_ARN,
          name,
          input: JSON.stringify({
            stackName: d.stackName,
            templateBody: JSON.stringify(agentTemplate(this.c, p, a, d)),
            deploymentId: d.id,
            tenantId: p.userId,
            agentId: a.id,
          }),
        }),
      );
      return { workflowArn: r.executionArn! };
    } catch (e) {
      if ((e as Error).name === "ExecutionAlreadyExists")
        return { workflowArn };
      throw e;
    }
  }
  private async stack(a: Agent) {
    const d = a.deployment!;
    try {
      return (
        await this.cf.send(
          new DescribeStacksCommand({ StackName: d.stackName }),
        )
      ).Stacks?.[0];
    } catch (e) {
      if ((e as Error).name === "ValidationError") return undefined;
      throw e;
    }
  }
  async status(p: Principal, a: Agent): Promise<RuntimeStatus> {
    const key = this.key(p, a),
      d = a.deployment!;
    const base: RuntimeStatus = {
      deploymentId: d.id,
      status: "PROVISIONING",
      versions: {
        configuration: d.configurationVersion,
        image: d.imageVersion,
      },
    };
    if (d.workflowArn) {
      const workflow = await this.sfn.send(
        new DescribeExecutionCommand({ executionArn: d.workflowArn }),
      );
      if (["FAILED", "TIMED_OUT", "ABORTED"].includes(workflow.status ?? ""))
        return {
          ...base,
          status: "FAILED",
          error:
            "Deployment workflow failed. The previous deployment remains recoverable.",
        };
    }
    const stack = await this.stack(a);
    if (!stack)
      return a.terminationRequested ? { ...base, status: "TERMINATED" } : base;
    if (stack.StackStatus?.startsWith("DELETE_"))
      return {
        ...base,
        status: stack.StackStatus === "DELETE_FAILED" ? "FAILED" : "STOPPING",
        error:
          stack.StackStatus === "DELETE_FAILED"
            ? "CloudFormation deletion failed; inspect remaining resources"
            : undefined,
      };
    if (
      stack.StackStatus?.includes("FAILED") ||
      stack.StackStatus?.includes("ROLLBACK")
    )
      return {
        ...base,
        status: "FAILED",
        error:
          "Infrastructure provisioning failed; inspect the scoped AWS deployment events.",
      };
    if (stack.StackStatus !== "CREATE_COMPLETE")
      return { ...base, status: "DEPLOYING" };
    const serviceArn = stack.Outputs?.find(
      (o) => o.OutputKey === "ServiceArn",
    )?.OutputValue;
    if (!serviceArn)
      return {
        ...base,
        status: "FAILED",
        error: "Missing runtime service output",
      };
    const [services, heartbeat, control, lease] = await Promise.all([
      this.ecs.send(
        new DescribeServicesCommand({
          cluster: this.c.KRONO_CLUSTER_ARN,
          services: [serviceArn],
        }),
      ),
      this.db.send(
        new GetCommand({
          TableName: this.c.KRONO_RUNTIME_TABLE,
          Key: { pk: key.pk, sk: `HEARTBEAT#${d.id}` },
          ConsistentRead: true,
        }),
      ),
      this.db.send(
        new GetCommand({
          TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
          Key: key,
          ConsistentRead: true,
        }),
      ),
      this.db.send(
        new GetCommand({
          TableName: this.c.KRONO_RUNTIME_TABLE,
          Key: { pk: key.pk, sk: "LEASE" },
          ConsistentRead: true,
        }),
      ),
    ]);
    const service = services.services?.[0],
      h = heartbeat.Item;
    if (!service || services.failures?.length)
      return {
        ...base,
        serviceArn,
        status: "FAILED",
        error: "ECS service is unavailable",
      };
    if (service.desiredCount === 0 && service.runningCount === 0)
      return {
        ...base,
        serviceArn,
        status: "STOPPED",
        heartbeatAt: h?.at,
        portfolio: h?.portfolio,
        currentTask: "Stopped; portfolio is a last recorded snapshot",
      };
    const fresh = h && Date.now() - Date.parse(h.at) < 90000;
    const tasks = await this.ecs.send(
      new ListTasksCommand({
        cluster: this.c.KRONO_CLUSTER_ARN,
        serviceName: serviceArn,
        desiredStatus: "RUNNING",
      }),
    );
    const described = tasks.taskArns?.length
      ? await this.ecs.send(
          new DescribeTasksCommand({
            cluster: this.c.KRONO_CLUSTER_ARN,
            tasks: tasks.taskArns,
          }),
        )
      : undefined;
    const healthy = described?.tasks?.some((t) => t.healthStatus === "HEALTHY");
    if (!fresh || !healthy || !service.runningCount)
      return { ...base, serviceArn, status: "HEALTH_CHECK" };
    // New workers are inert until health is verified and the old lease/checkpoint has drained.
    if (
      control.Item?.candidateDeployment === d.id &&
      control.Item.activeDeployment !== d.id
    ) {
      if (lease.Item?.expiresAt > Math.floor(Date.now() / 1000))
        return {
          ...base,
          serviceArn,
          status: "HEALTH_CHECK",
          currentTask:
            "Waiting for prior runtime to checkpoint and release its lease",
        };
      try {
        await this.db.send(
          new UpdateCommand({
            TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
            Key: key,
            UpdateExpression:
              "SET activeDeployment=:id, activeSpec=:spec, expiresAt=:expires, desired=:run, #v=#v+:one REMOVE candidateDeployment, candidateSpec, candidateExpiresAt",
            ConditionExpression: "#v=:v AND candidateDeployment=:id",
            ExpressionAttributeNames: { "#v": "version" },
            ExpressionAttributeValues: {
              ":id": d.id,
              ":spec": control.Item.candidateSpec,
              ":expires": d.expiresAt,
              ":run": control.Item.candidateActivationDesired ?? "RUN",
              ":one": 1,
              ":v": control.Item.version,
            },
          }),
        );
      } catch (e) {
        if ((e as Error).name !== "ConditionalCheckFailedException") throw e;
      }
      return {
        ...base,
        serviceArn,
        status: "HEALTH_CHECK",
        currentTask: "Activating healthy runtime",
      };
    }
    const status =
      h.status === "PAUSED"
        ? "PAUSED"
        : h.status === "STOPPED"
          ? "STOPPED"
          : h.status === "FAILED"
            ? "FAILED"
            : h.status === "RUNNING"
              ? "RUNNING"
              : "HEALTH_CHECK";
    return {
      ...base,
      serviceArn,
      status,
      heartbeatAt: h.at,
      taskArn: described?.tasks?.[0]?.taskArn,
      currentTask: h.currentTask,
      selectedStrategy: h.selectedStrategy,
      regime: h.regime,
      nextRunAt: h.nextRunAt,
      lastExecution: h.lastExecution,
      portfolio: h.portfolio,
    };
  }
  async control(
    p: Principal,
    a: Agent,
    command: "PAUSE" | "RESUME" | "STOP" | "RESTART" | "TERMINATE",
  ) {
    const key = this.key(p, a),
      d = a.deployment!;
    const current = await this.db.send(
      new GetCommand({
        TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
        Key: key,
        ConsistentRead: true,
      }),
    );
    if (!current.Item) throw conflict();
    if (
      ["RESUME", "RESTART"].includes(command) &&
      Number(current.Item.expiresAt) < Date.now() / 1000
    )
      throw denied("Runtime budget expired; approve a new deployment");
    const desired =
      command === "PAUSE"
        ? "PAUSE"
        : command === "RESUME" || command === "RESTART"
          ? "RUN"
          : "STOP";
    await this.db.send(
      new UpdateCommand({
        TableName: this.c.KRONO_AGENT_CONTROL_TABLE,
        Key: key,
        UpdateExpression:
          "SET desired=:desired, candidateActivationDesired=:desired, #v=#v+:one",
        ConditionExpression: "#v=:v",
        ExpressionAttributeNames: { "#v": "version" },
        ExpressionAttributeValues: {
          ":desired": desired,
          ":one": 1,
          ":v": current.Item.version,
        },
      }),
    );
    const stack = await this.stack(a),
      arn = stack?.Outputs?.find(
        (o) => o.OutputKey === "ServiceArn",
      )?.OutputValue;
    if (arn && command !== "PAUSE")
      await this.ecs.send(
        new UpdateServiceCommand({
          cluster: this.c.KRONO_CLUSTER_ARN,
          service: arn,
          desiredCount: desired === "STOP" ? 0 : 1,
          forceNewDeployment: command === "RESTART",
        }),
      );
    if (command === "TERMINATE")
      await this.cf.send(
        new DeleteStackCommand({
          StackName: d.stackName,
          RoleARN: this.c.KRONO_PROVISIONER_ROLE_ARN,
        }),
      );
  }
  async events(p: Principal, a: Agent, limit = 50, cursor?: string) {
    const key = this.key(p, a);
    let start: Record<string, unknown> | undefined;
    if (cursor) {
      try {
        start = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          start?.pk !== key.pk ||
          typeof start?.sk !== "string" ||
          !start.sk.startsWith("EVENT#")
        )
          throw Error();
      } catch {
        throw denied("Invalid event cursor");
      }
    }
    const r = await this.db.send(
      new QueryCommand({
        TableName: this.c.KRONO_RUNTIME_TABLE,
        KeyConditionExpression: "pk=:pk AND begins_with(sk,:prefix)",
        ExpressionAttributeValues: { ":pk": key.pk, ":prefix": "EVENT#" },
        Limit: Math.min(100, limit),
        ScanIndexForward: false,
        ExclusiveStartKey: start,
      }),
    );
    return {
      items: r.Items ?? [],
      cursor: r.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(r.LastEvaluatedKey)).toString("base64url")
        : undefined,
    };
  }
  async logs(p: Principal, a: Agent, limit = 50, nextToken?: string) {
    this.key(p, a);
    let providerToken: string | undefined;
    if (nextToken) {
      if (!/^[a-f0-9-]{36}$/.test(nextToken))
        throw denied("Invalid log cursor");
      const cursor = await this.db.send(
        new GetCommand({
          TableName: this.c.KRONO_CONTROL_TABLE,
          Key: { pk: `TENANT#${p.userId}`, sk: `LOG_CURSOR#${nextToken}` },
          ConsistentRead: true,
        }),
      );
      if (
        !cursor.Item ||
        cursor.Item.deploymentId !== a.deployment!.id ||
        cursor.Item.expiresAt < Date.now() / 1000
      )
        throw denied("Expired or unauthorized log cursor");
      providerToken = cursor.Item.token;
    }
    const r = await this.logsClient.send(
      new FilterLogEventsCommand({
        logGroupName: this.c.KRONO_AGENT_LOG_GROUP,
        logStreamNamePrefix: `${a.deployment!.id}/agent/`,
        limit: Math.min(100, limit),
        nextToken: providerToken,
      }),
    );
    const cursor = r.nextToken ? randomUUID() : undefined;
    if (cursor)
      await this.db.send(
        new PutCommand({
          TableName: this.c.KRONO_CONTROL_TABLE,
          Item: {
            pk: `TENANT#${p.userId}`,
            sk: `LOG_CURSOR#${cursor}`,
            deploymentId: a.deployment!.id,
            token: r.nextToken,
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    return {
      items: (r.events ?? []).map((e) => ({
        at: e.timestamp,
        message: e.message,
      })),
      nextToken: cursor,
    };
  }
  async metrics(p: Principal, a: Agent) {
    this.key(p, a);
    const dimensions = [
      {
        Name: "ClusterName",
        Value: this.c.KRONO_CLUSTER_ARN.split("/").at(-1)!,
      },
      { Name: "ServiceName", Value: a.deployment!.stackName },
    ];
    const results = await Promise.all(
      ["CPUUtilization", "MemoryUtilization"].map((MetricName) =>
        this.cw.send(
          new GetMetricStatisticsCommand({
            Namespace: "AWS/ECS",
            MetricName,
            Dimensions: dimensions,
            StartTime: new Date(Date.now() - 600000),
            EndTime: new Date(),
            Period: 60,
            Statistics: ["Average"],
          }),
        ),
      ),
    );
    return Object.fromEntries(
      results.map((r, i) => [
        i ? "memoryPercent" : "cpuPercent",
        r.Datapoints?.sort(
          (a, b) => b.Timestamp!.getTime() - a.Timestamp!.getTime(),
        )[0]?.Average ?? null,
      ]),
    );
  }
}
