import { createHash, randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { conflict, denied, missing, PlatformError } from "../domain/errors.js";
import {
  confirmationSchema,
  idSchema,
  specSchema,
  profileSchema,
  type Agent,
  type AgentSpec,
  type Deployment,
  type Principal,
  type Profile,
} from "../domain/schemas.js";
import type { TenantStore, Write } from "../storage/tenant-store.js";
import type { Config } from "../config.js";
import type { RuntimeProvider } from "../runtime/runtime.interface.js";
import { ProfileService } from "../profiles/profile.service.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
interface Quota {
  slots: string[];
  day: string;
  reservedRuntimeSeconds: number;
}
export class AgentService {
  constructor(
    public store: TenantStore,
    public runtime: RuntimeProvider,
    private config: Config,
    private profiles: ProfileService,
  ) {}
  async emergencyStop(p: Principal) {
    if (!this.runtime.setEmergency)
      throw new PlatformError(
        "UNAVAILABLE",
        "Tenant execution barrier is unavailable",
        503,
      );
    const policy = await this.runtime.setEmergency(p, true),
      failures: string[] = [];
    const agents = (await this.store.list<Agent>(p, "AGENT", 100)).items.filter(
      (r) => r.data.deployment && r.data.state !== "TERMINATED",
    );
    for (const a of agents) {
      try {
        await this.runtime.control(p, a.data, "PAUSE");
      } catch {
        failures.push(a.id);
      }
    }
    const prior = await this.store.get(p, "CONFIG", "emergency");
    await this.store.commit(
      p,
      [
        {
          kind: "CONFIG",
          id: "emergency",
          expectedVersion: prior?.version ?? 0,
          data: policy,
        },
      ],
      "emergency.activated",
      { policy, agentsAwaitingPause: failures },
    );
    return {
      ...policy,
      entriesBlocked: true,
      agentsAwaitingPause: failures,
      positionPolicy: "HOLD_AND_REVIEW",
    };
  }
  async updateProfile(p: Principal, input: unknown, expectedVersion: number) {
    const next = profileSchema.parse(input),
      prior = await this.profiles.get(p);
    if (prior.version !== expectedVersion) throw conflict();
    const riskChanged =
      digest(next.riskProfile) !== digest(prior.data.riskProfile) ||
      digest(next.tradingProfile.restrictedAssets) !==
        digest(prior.data.tradingProfile.restrictedAssets);
    if (riskChanged) {
      const active = (
        await this.store.list<Agent>(p, "AGENT", 100)
      ).items.filter(
        (r) =>
          r.data.deployment &&
          !["STOPPED", "FAILED", "TERMINATED"].includes(r.data.state),
      );
      for (const row of active)
        await this.runtime.control(p, row.data, "PAUSE");
    }
    const result = await this.profiles.update(p, next, expectedVersion);
    return {
      ...result,
      notice: riskChanged
        ? "Active agents were paused before the risk change. Review and redeploy compatible specifications before resuming."
        : "Saved profile preferences updated",
    };
  }
  async portfolio(p: Principal) {
    const rows = (await this.store.list<Agent>(p, "AGENT", 100)).items.filter(
      (r) => r.data.deployment && r.data.state !== "TERMINATED",
    );
    const snapshots = [];
    let equity = new Decimal(0),
      realized = new Decimal(0),
      unrealized = new Decimal(0),
      fees = new Decimal(0),
      complete = true;
    for (const row of rows) {
      try {
        const observed = await this.runtime.status(p, row.data),
          portfolio = observed.portfolio as Record<string, unknown> | undefined;
        const fresh =
          !!observed.heartbeatAt &&
          Date.now() - Date.parse(observed.heartbeatAt) < 90000;
        const valid =
          fresh && !!portfolio?.valuation_complete && portfolio.equity != null;
        snapshots.push({
          agentId: row.id,
          name: row.data.specification.name,
          heartbeatAt: observed.heartbeatAt,
          portfolio: portfolio ?? null,
          fresh,
          valid,
        });
        if (!valid) {
          complete = false;
          continue;
        }
        equity = equity.add(String(portfolio!.equity));
        realized = realized.add(String(portfolio!.realized_pnl));
        unrealized = unrealized.add(String(portfolio!.unrealized_pnl));
        fees = fees.add(String(portfolio!.fees));
      } catch {
        complete = false;
        snapshots.push({ agentId: row.id, available: false });
      }
    }
    return {
      mode: "SIMULATION",
      equity: complete && rows.length ? equity.toString() : null,
      realizedPnl: complete && rows.length ? realized.toString() : null,
      unrealizedPnl: complete && rows.length ? unrealized.toString() : null,
      fees: complete && rows.length ? fees.toString() : null,
      valuationComplete: complete && rows.length > 0,
      agents: snapshots,
      calculation:
        "Sum of separate simulated agent ledgers, not shared wallet capital. Missing or stale snapshots prevent aggregate valuation.",
    };
  }
  async get(p: Principal, id: string) {
    idSchema.parse(id);
    const row = await this.store.get<Agent>(p, "AGENT", id);
    if (
      !row ||
      row.data.ownerId !== p.userId ||
      row.data.state === "TERMINATED"
    )
      throw missing();
    return row;
  }
  async validate(p: Principal, input: unknown): Promise<AgentSpec> {
    const spec = specSchema.parse(input),
      profile = (await this.profiles.get(p)).data;
    if (
      spec.coordination.publishOpportunities &&
      (spec.type !== "research" || !spec.permissions.generateSignals)
    )
      throw denied(
        "Opportunity publication requires a research agent with signal generation enabled; monitoring agents publish observation events only",
      );
    if (
      spec.type !== "news_monitor" &&
      spec.configuration.timeframes.some((t) => t !== "1h")
    )
      throw new PlatformError(
        "TIMEFRAME_UNAVAILABLE",
        "The approved strategy runtime currently evaluates closed hourly candles. Four-hour and daily charts are descriptive only",
        422,
      );
    const bounded = (
      r: AgentSpec["riskPolicy"],
      cap: Profile["riskProfile"],
    ) => {
      for (const k of [
        "maxRiskPerTrade",
        "maxDailyLoss",
        "maxPortfolioExposure",
        "maxAssetExposure",
        "maxConcurrentPositions",
        "slippageBps",
        "maxPriceImpact",
        "maxNetworkFee",
        "maxDrawdown",
        "maxTradeNotional",
      ] as const) {
        if (new Decimal(r[k]).greaterThan(cap[k]))
          throw denied(`Agent ${k} exceeds your saved risk policy`);
      }
      if (
        new Decimal(r.minimumLiquidity).lessThan(cap.minimumLiquidity) ||
        r.cooldownSeconds < cap.cooldownSeconds
      )
        throw denied(
          "Agent liquidity/cooldown policy is less restrictive than your profile",
        );
    };
    bounded(spec.riskPolicy, profile.riskProfile);
    if (
      spec.configuration.assets.some((a) =>
        profile.tradingProfile.restrictedAssets.includes(a),
      )
    )
      throw denied("A selected asset is restricted by your profile");
    const catalog = await this.store.get<{
      marketAssets: string[];
      newsAssets: string[];
    }>(p, "CONFIG", "asset_catalog");
    const assets = catalog?.data ?? {
      marketAssets: ["BTC", "ETH", "SOL"],
      newsAssets: ["BTC", "ETH", "SOL", "HSK"],
    };
    const supported =
      spec.type === "news_monitor" ? assets.newsAssets : assets.marketAssets;
    if (spec.configuration.assets.some((a) => !supported.includes(a)))
      throw new PlatformError(
        "ASSET_UNAVAILABLE",
        "No configured market provider for one or more assets. HSK supports news monitoring only until a verified market provider is configured",
        422,
      );
    for (const id of spec.coordination.researchAgentIds) {
      const source = await this.get(p, id);
      if (
        !["research", "news_monitor", "market_monitor"].includes(
          source.data.specification.type,
        ) ||
        !source.data.specification.coordination.publishOpportunities
      )
        throw denied(
          "Coordination requires an owned research agent with publication enabled",
        );
    }
    return spec;
  }
  async templates(p: Principal) {
    const saved = await this.store.get<
      { id: string; version: number; specification: AgentSpec }[]
    >(p, "CONFIG", "managed_templates");
    if (saved) return saved;
    const profile = (await this.profiles.get(p)).data;
    const base = {
      description:
        "KRONO-maintained declarative template. Isolated per user; execution requires a reviewed deployment.",
      riskPolicy: profile.riskProfile,
      permissions: {
        readMarketData: true,
        readPortfolio: false,
        generateSignals: true,
        executeTrades: false,
        modifyRiskSettings: false,
      },
      execution: {
        template: "krono-python-v1",
        mode: "SIMULATION",
        automaticSimulationFills: false,
      },
      coordination: { publishOpportunities: true, researchAgentIds: [] },
    };
    const templates = [
      {
        id: "market-research",
        version: 1,
        specification: specSchema.parse({
          ...base,
          name: "Krono Market Research",
          type: "research",
          configuration: {
            assets: profile.tradingProfile.preferredAssets.length
              ? profile.tradingProfile.preferredAssets.slice(0, 10)
              : ["BTC"],
            strategies: [
              "momentum_v1",
              "mean_reversion_v1",
              "trend_following_v1",
              "breakout_v1",
              "spread_research_v1",
            ],
          },
        }),
      },
      {
        id: "news-monitor",
        version: 1,
        specification: specSchema.parse({
          ...base,
          name: "Krono News Intelligence",
          type: "news_monitor",
          permissions: { ...base.permissions, generateSignals: false },
          coordination: { publishOpportunities: false, researchAgentIds: [] },
          configuration: {
            assets: profile.tradingProfile.preferredAssets.length
              ? profile.tradingProfile.preferredAssets.slice(0, 10)
              : ["HSK"],
            strategies: [],
          },
        }),
      },
    ];
    try {
      await this.store.commit(
        p,
        [
          {
            kind: "CONFIG",
            id: "managed_templates",
            expectedVersion: 0,
            data: templates,
          },
        ],
        "templates.registered",
        { version: 1 },
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "CONFLICT") throw e;
    }
    return (await this.store.get<typeof templates>(
      p,
      "CONFIG",
      "managed_templates",
    ))!;
  }
  async fromTemplate(p: Principal, id: string) {
    const template = (await this.templates(p)).data.find((t) => t.id === id);
    if (!template) throw missing();
    const profile = (await this.profiles.get(p)).data;
    return this.create(
      p,
      { ...template.specification, riskPolicy: profile.riskProfile },
      "KRONO_MANAGED",
    );
  }
  async create(
    p: Principal,
    input: unknown,
    origin: Agent["origin"] = "USER_CREATED",
  ) {
    const specification = await this.validate(p, input),
      at = new Date().toISOString(),
      id = randomUUID();
    const agent: Agent = {
      origin,
      id,
      ownerId: p.userId,
      specification,
      state: "DRAFT",
      configurationState: "DRAFT",
      configurationVersion: 1,
      deploymentVersion: 0,
      createdAt: at,
      updatedAt: at,
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const definitions = await this.store.get<{ count: number }>(
        p,
        "QUOTA",
        "definitions",
      );
      if (
        (definitions?.data.count ?? 0) >=
        this.config.KRONO_MAX_AGENT_SPECS_PER_USER
      )
        throw new PlatformError(
          "AGENT_QUOTA",
          "Agent definition quota reached. Delete an unneeded draft or stopped agent first",
          429,
        );
      try {
        await this.store.commit(
          p,
          [
            { kind: "AGENT", id, expectedVersion: 0, data: agent },
            {
              kind: "QUOTA",
              id: "definitions",
              expectedVersion: definitions?.version ?? 0,
              data: { count: (definitions?.data.count ?? 0) + 1 },
            },
            {
              kind: `AGENT_SPEC_${id}`,
              id: "1",
              expectedVersion: 0,
              data: specification,
            },
          ],
          "agent.created",
          { agentId: id },
        );
        return this.get(p, id);
      } catch (e) {
        if ((e as { code?: string }).code !== "CONFLICT" || attempt === 3)
          throw e;
      }
    }
    throw conflict();
  }
  async preview(p: Principal, id: string) {
    let row = await this.get(p, id);
    await this.validate(p, row.data.specification);
    if (row.data.configurationState !== "APPROVAL_REQUIRED") {
      await this.store.commit(
        p,
        [
          {
            kind: "AGENT",
            id,
            expectedVersion: row.version,
            data: { ...row.data, configurationState: "APPROVAL_REQUIRED" },
          },
        ],
        "agent.validation.completed",
        { agentId: id, configurationVersion: row.data.configurationVersion },
      );
      row = await this.get(p, id);
    }
    return {
      ...row,
      digest: digest({
        agentId: id,
        version: row.version,
        spec: row.data.specification,
        image: this.config.KRONO_AGENT_IMAGE,
      }),
      image: this.config.KRONO_AGENT_IMAGE,
      mode: "SIMULATION",
      warnings: [
        ...(row.data.deployment &&
        row.data.deployment.configurationVersion !==
          row.data.configurationVersion
          ? [
              `Draft revision: the active runtime still uses configuration ${row.data.deployment.configurationVersion}. The reviewed revision requires deployment and health validation.`,
            ]
          : []),
        "Simulated ledger only. No wallet signing or live swap submission.",
        "Fargate tasks and network infrastructure incur AWS charges.",
      ],
    };
  }
  async update(
    p: Principal,
    id: string,
    input: unknown,
    expectedVersion: number,
  ) {
    const row = await this.get(p, id),
      specification = await this.validate(p, input);
    if (
      ["PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "STOPPING"].includes(
        row.data.state,
      )
    )
      throw new PlatformError(
        "DEPLOYMENT_BUSY",
        "Wait for the current deployment/control operation before changing its specification",
        409,
      );
    if (row.version !== expectedVersion) throw conflict();
    if (
      row.data.deployment &&
      digest({
        configuration: row.data.specification.configuration,
        risk: row.data.specification.riskPolicy,
        permissions: row.data.specification.permissions,
      }) !==
        digest({
          configuration: specification.configuration,
          risk: specification.riskPolicy,
          permissions: specification.permissions,
        })
    )
      await this.runtime.control(p, row.data, "PAUSE");
    const version = row.data.configurationVersion + 1;
    // A running version remains active until the reviewed revision passes deployment health checks.
    const data = {
      ...row.data,
      specification,
      configurationVersion: version,
      configurationState: "DRAFT" as const,
      updatedAt: new Date().toISOString(),
    };
    await this.store.commit(
      p,
      [
        { kind: "AGENT", id, expectedVersion, data },
        {
          kind: `AGENT_SPEC_${id}`,
          id: String(version),
          expectedVersion: 0,
          data: specification,
        },
      ],
      "agent.configuration.updated",
      { agentId: id, version, requiresRedeployment: true },
    );
    return this.preview(p, id);
  }
  async rollback(
    p: Principal,
    id: string,
    version: number,
    expectedVersion: number,
  ) {
    const prior = await this.store.get<AgentSpec>(
      p,
      `AGENT_SPEC_${id}`,
      String(version),
    );
    if (!prior) throw missing();
    return this.update(p, id, prior.data, expectedVersion);
  }
  async deploy(p: Principal, id: string, input: unknown) {
    if ((await this.runtime.tenantPolicy?.(p))?.emergency)
      throw denied(
        "Emergency stop is latched. Clear it explicitly before deployment",
      );
    if (this.config.KRONO_AGENT_IMAGE.endsWith("sha256:" + "0".repeat(64)))
      throw new PlatformError(
        "IMAGE_UNCONFIGURED",
        "Build and configure the immutable approved runtime image before deployment",
        503,
      );
    const confirm = confirmationSchema.parse(input),
      row = await this.get(p, id);
    await this.validate(p, row.data.specification);
    const expectedDigest = digest({
      agentId: id,
      version: row.version,
      spec: row.data.specification,
      image: this.config.KRONO_AGENT_IMAGE,
    });
    if (
      row.version !== confirm.expectedVersion ||
      confirm.digest !== expectedDigest ||
      row.data.configurationState !== "APPROVAL_REQUIRED"
    )
      throw conflict();
    if (
      ["PROVISIONING", "DEPLOYING", "HEALTH_CHECK", "STOPPING"].includes(
        row.data.state,
      )
    )
      throw conflict();
    const quota = await this.store.get<Quota>(p, "QUOTA", "compute"),
      day = new Date().toISOString().slice(0, 10);
    const q = quota?.data ?? { slots: [], day, reservedRuntimeSeconds: 0 };
    if (q.day !== day) {
      q.day = day;
      q.reservedRuntimeSeconds = 0;
    }
    const replacement = !!row.data.deployment;
    // Version upgrades briefly need two isolated workloads and reserve their full runtime budget.
    if (
      (!q.slots.includes(id) &&
        q.slots.length >= this.config.KRONO_MAX_AGENTS_PER_USER) ||
      q.reservedRuntimeSeconds +
        row.data.specification.execution.maxRuntimeSeconds >
        this.config.KRONO_DAILY_RUNTIME_SECONDS
    )
      throw new PlatformError(
        "COMPUTE_QUOTA",
        "Deployment or daily runtime quota reached",
        429,
      );
    const deploymentVersion = row.data.deploymentVersion + 1,
      deploymentId = randomUUID();
    const deployment: Deployment = {
      version: deploymentVersion,
      id: deploymentId,
      stackName: `krono-${this.config.KRONO_ENV}-agent-${id}-v${deploymentVersion}`,
      imageVersion: this.config.KRONO_AGENT_IMAGE,
      configurationVersion: row.data.configurationVersion,
      startedAt: new Date().toISOString(),
      expiresAt:
        Math.floor(Date.now() / 1000) +
        row.data.specification.execution.maxRuntimeSeconds,
    };
    const agent: Agent = {
      ...row.data,
      state: "PROVISIONING",
      configurationState: "APPROVED",
      previousVersion: replacement ? row.data.deploymentVersion : undefined,
      deploymentVersion,
      deployment,
      updatedAt: new Date().toISOString(),
    };
    await this.store.commit(
      p,
      [
        { kind: "AGENT", id, expectedVersion: row.version, data: agent },
        {
          kind: "DEPLOYMENT",
          id: deploymentId,
          expectedVersion: 0,
          data: {
            ...deployment,
            agentId: id,
            specification: agent.specification,
            previousDeployment: row.data.deployment ?? null,
          },
        },
        {
          kind: "QUOTA",
          id: "compute",
          expectedVersion: quota?.version ?? 0,
          data: {
            ...q,
            slots: [...new Set([...q.slots, id])],
            reservedRuntimeSeconds:
              q.reservedRuntimeSeconds +
              agent.specification.execution.maxRuntimeSeconds,
          },
        },
      ],
      "deployment.approved",
      { agentId: id, deploymentId, digest: confirm.digest },
    );
    // The persisted record is an outbox. Retrying start is named/idempotent and never creates an extra task.
    await this.launch(p, agent);
    return this.get(p, id);
  }
  private async launch(p: Principal, agent: Agent) {
    await this.runtime.prepare(
      p,
      agent,
      agent.specification,
      agent.deployment!,
    );
    const started = await this.runtime.deploy(p, agent, agent.deployment!);
    const row = await this.get(p, agent.id);
    if (row.data.deployment?.id !== agent.deployment!.id) throw conflict();
    await this.store.commit(
      p,
      [
        {
          kind: "AGENT",
          id: agent.id,
          expectedVersion: row.version,
          data: {
            ...row.data,
            state: "DEPLOYING",
            deployment: {
              ...row.data.deployment,
              workflowArn: started.workflowArn,
            },
          },
        },
      ],
      "deployment.started",
      { agentId: agent.id, deploymentId: agent.deployment!.id },
    );
  }
  async status(p: Principal, id: string) {
    let row = await this.get(p, id);
    if (!row.data.deployment) return { agent: row, runtime: null };
    if (["PROVISIONING", "DEPLOYING", "HEALTH_CHECK"].includes(row.data.state))
      await this.validate(p, row.data.specification);
    if (row.data.state === "PROVISIONING") {
      await this.launch(p, row.data);
      row = await this.get(p, id);
    }
    const status = await this.runtime.status(p, row.data);
    if (status.status === "FAILED") {
      const failed = await this.store.get<{ previousDeployment?: Deployment }>(
        p,
        "DEPLOYMENT",
        row.data.deployment!.id,
      );
      if (failed?.data.previousDeployment) {
        const data = {
          ...row.data,
          deployment: failed.data.previousDeployment,
          state: "PAUSED" as const,
          configurationState: "APPROVAL_REQUIRED" as const,
        };
        await this.runtime.control(p, data, "PAUSE");
        await this.store.commit(
          p,
          [{ kind: "AGENT", id, expectedVersion: row.version, data }],
          "deployment.failed.previous_preserved",
          {
            agentId: id,
            failedDeploymentId: row.data.deployment!.id,
            activeDeploymentId: data.deployment.id,
          },
        );
        return {
          agent: await this.get(p, id),
          runtime: await this.runtime.status(p, data),
          failedDeploymentId: row.data.deployment!.id,
        };
      }
    }
    const desired = status.status;
    if (row.data.state !== desired) {
      const q = await this.store.get<Quota>(p, "QUOTA", "compute");
      const writes: Write[] = [
        {
          kind: "AGENT",
          id,
          expectedVersion: row.version,
          data: {
            ...row.data,
            state: desired,
            updatedAt: new Date().toISOString(),
          },
        },
      ];
      if (q && ["STOPPED", "FAILED", "TERMINATED"].includes(desired))
        writes.push({
          kind: "QUOTA",
          id: "compute",
          expectedVersion: q.version,
          data: { ...q.data, slots: q.data.slots.filter((a) => a !== id) },
        });
      if (desired === "TERMINATED") {
        const definitions = await this.store.get<{ count: number }>(
          p,
          "QUOTA",
          "definitions",
        );
        if (definitions)
          writes.push({
            kind: "QUOTA",
            id: "definitions",
            expectedVersion: definitions.version,
            data: { count: Math.max(0, definitions.data.count - 1) },
          });
      }
      try {
        await this.store.commit(p, writes, "agent.runtime.observed", {
          agentId: id,
          state: desired,
        });
      } catch (e) {
        if ((e as { code?: string }).code !== "CONFLICT") throw e;
      }
      row = (await this.store.get<Agent>(p, "AGENT", id))!;
    }
    return { agent: row, runtime: status };
  }
  async control(
    p: Principal,
    id: string,
    command: "PAUSE" | "RESUME" | "STOP" | "RESTART" | "TERMINATE",
    version: number,
    acknowledgement?: string,
  ) {
    const row = await this.get(p, id);
    if (row.version !== version) throw conflict();
    if (!row.data.deployment) {
      if (command !== "TERMINATE") throw conflict();
      if (acknowledgement !== `DELETE ${id}`)
        throw denied("Explicit deletion confirmation is required");
      const definitions = await this.store.get<{ count: number }>(
        p,
        "QUOTA",
        "definitions",
      );
      const writes: Write[] = [
        {
          kind: "AGENT",
          id,
          expectedVersion: version,
          data: { ...row.data, state: "TERMINATED" },
        },
      ];
      if (definitions)
        writes.push({
          kind: "QUOTA",
          id: "definitions",
          expectedVersion: definitions.version,
          data: { count: Math.max(0, definitions.data.count - 1) },
        });
      await this.store.commit(p, writes, "agent.draft.deleted", {
        agentId: id,
      });
      return { state: "TERMINATED" };
    }
    if (command === "RESUME" || command === "RESTART") {
      if ((await this.runtime.tenantPolicy?.(p))?.emergency)
        throw denied("Emergency stop is latched");
      const active = await this.store.get<AgentSpec>(
        p,
        `AGENT_SPEC_${id}`,
        String(row.data.deployment.configurationVersion),
      );
      if (!active)
        throw denied("Missing active configuration; review a new deployment");
      await this.validate(p, active.data);
    }
    if (command === "TERMINATE" && acknowledgement !== `DELETE ${id}`)
      throw denied("Explicit deletion confirmation is required");
    const operationId = randomUUID(),
      writes: Write[] = [
        {
          kind: "AGENT",
          id,
          expectedVersion: version,
          data: {
            ...row.data,
            state:
              command === "STOP" || command === "TERMINATE"
                ? "STOPPING"
                : row.data.state,
            terminationRequested:
              command === "TERMINATE" || row.data.terminationRequested,
            updatedAt: new Date().toISOString(),
          },
        },
        {
          kind: "CONTROL_REQUEST",
          id: operationId,
          expectedVersion: 0,
          data: { agentId: id, command, status: "DISPATCHING" },
        },
      ];
    if (command === "RESUME" || command === "RESTART") {
      const q = await this.store.get<Quota>(p, "QUOTA", "compute");
      if (!q) throw denied("Missing deployment reservation");
      if (!q.data.slots.includes(id)) {
        if (q.data.slots.length >= this.config.KRONO_MAX_AGENTS_PER_USER)
          throw new PlatformError(
            "COMPUTE_QUOTA",
            "Concurrent deployment quota reached",
            429,
          );
        writes.push({
          kind: "QUOTA",
          id: "compute",
          expectedVersion: q.version,
          data: { ...q.data, slots: [...q.data.slots, id] },
        });
      }
    }
    // Consume the exact version before making an external call: concurrent/replayed restarts cannot dispatch twice.
    await this.store.commit(
      p,
      writes,
      `agent.control.${command.toLowerCase()}`,
      { agentId: id, operationId },
    );
    try {
      await this.runtime.control(p, row.data, command);
      await this.store.commit(
        p,
        [
          {
            kind: "CONTROL_REQUEST",
            id: operationId,
            expectedVersion: 1,
            data: { agentId: id, command, status: "ACCEPTED" },
          },
        ],
        "agent.control.accepted",
        { agentId: id, operationId },
      );
    } catch (e) {
      await this.store.commit(
        p,
        [
          {
            kind: "CONTROL_REQUEST",
            id: operationId,
            expectedVersion: 1,
            data: {
              agentId: id,
              command,
              status: "UNKNOWN",
              errorType: (e as Error).name,
            },
          },
        ],
        "agent.control.uncertain",
        { agentId: id, operationId },
      );
      throw new PlatformError(
        "CONTROL_UNCERTAIN",
        "Control request outcome is uncertain. Inspect runtime state before issuing another command",
        503,
      );
    }
    return command === "TERMINATE"
      ? { state: "STOPPING", operationId }
      : this.status(p, id);
  }
}
