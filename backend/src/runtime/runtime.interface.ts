import type {
  Agent,
  AgentSpec,
  Deployment,
  Principal,
} from "../domain/schemas.js";
export interface RuntimeStatus {
  deploymentId: string;
  status:
    | "PROVISIONING"
    | "DEPLOYING"
    | "HEALTH_CHECK"
    | "RUNNING"
    | "PAUSED"
    | "STOPPED"
    | "STOPPING"
    | "TERMINATED"
    | "FAILED";
  taskArn?: string;
  serviceArn?: string;
  heartbeatAt?: string;
  currentTask?: string;
  selectedStrategy?: string;
  regime?: string;
  nextRunAt?: string;
  lastExecution?: string;
  metrics?: { cpuPercent?: number; memoryPercent?: number };
  portfolio?: unknown;
  error?: string;
  versions?: { configuration: number; image: string };
}
export interface RuntimeProvider {
  tenantPolicy?(p: Principal): Promise<{ emergency: boolean; version: number }>;
  setEmergency?(
    p: Principal,
    active: boolean,
    expectedVersion?: number,
  ): Promise<{ emergency: boolean; version: number }>;
  metrics?(p: Principal, agent: Agent): Promise<unknown>;
  deploy(
    p: Principal,
    agent: Agent,
    deployment: Deployment,
  ): Promise<{ workflowArn: string }>;
  status(p: Principal, agent: Agent): Promise<RuntimeStatus>;
  control(
    p: Principal,
    agent: Agent,
    command: "PAUSE" | "RESUME" | "STOP" | "RESTART" | "TERMINATE",
  ): Promise<void>;
  events(
    p: Principal,
    agent: Agent,
    limit?: number,
    cursor?: string,
  ): Promise<{ items: unknown[]; cursor?: string }>;
  logs(
    p: Principal,
    agent: Agent,
    limit?: number,
    nextToken?: string,
  ): Promise<{ items: unknown[]; nextToken?: string }>;
  prepare(
    p: Principal,
    agent: Agent,
    spec: AgentSpec,
    deployment: Deployment,
  ): Promise<void>;
}
