let csrf = "";
export async function platform<T>(
  path: string,
  method = "GET",
  body?: unknown,
  retry = true,
): Promise<T> {
  const response = await fetch(`/platform${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" && csrf ? { "x-krono-csrf": csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({
    error: {
      message:
        "The AWS control plane is not configured or available. See the AWS setup guide.",
    },
  }));
  if (response.status === 401 && retry && !path.startsWith("/auth/")) {
    const refresh = await fetch("/platform/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    });
    if (refresh.ok) {
      const session = await refresh.json();
      csrf = session.csrf;
      if (method === "GET") return platform<T>(path, method, body, false);
      throw Error(
        "Your session was refreshed. Review and submit the action again; it was not resent automatically.",
      );
    }
  }
  if (!response.ok)
    throw Error(result.error?.message ?? "Platform request failed");
  if (result.csrf) csrf = result.csrf;
  return result as T;
}
export interface AgentSpec {
  name: string;
  description: string;
  type: string;
  configuration: {
    assets: string[];
    strategies: string[];
    monitoringInterval: number;
    [key: string]: unknown;
  };
  riskPolicy: Record<string, number | string>;
  permissions: {
    executeTrades: boolean;
    generateSignals: boolean;
    [key: string]: boolean;
  };
  execution: {
    mode: string;
    template: string;
    cpu: number;
    memoryMiB: number;
    maxRuntimeSeconds: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface AgentRow {
  id: string;
  version: number;
  updatedAt: string;
  data: {
    origin?: "KRONO_MANAGED" | "USER_CREATED";
    name?: string;
    specification: AgentSpec;
    state: string;
    configurationVersion: number;
    deploymentVersion: number;
    deployment?: {
      id: string;
      imageVersion: string;
      expiresAt: number;
      configurationVersion: number;
      version?: number;
    };
  };
}
export interface Runtime {
  status: string;
  currentTask?: string;
  heartbeatAt?: string;
  selectedStrategy?: string;
  regime?: string;
  nextRunAt?: string;
  portfolio?: Record<string, unknown>;
  error?: string;
}
export interface Preview extends AgentRow {
  digest: string;
  warnings: string[];
  image: string;
}
