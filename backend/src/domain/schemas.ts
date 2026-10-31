import { z } from "zod";
import { Decimal } from "decimal.js";

export const idSchema = z.string().uuid();
export const strategyId = z.enum([
  "momentum_v1",
  "mean_reversion_v1",
  "trend_following_v1",
  "breakout_v1",
  "spread_research_v1",
]);
export const decimal = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,18})?$/);
export const riskSchema = z
  .object({
    maxRiskPerTrade: z.number().positive().max(0.02).default(0.005),
    maxDailyLoss: z.number().positive().max(0.05).default(0.03),
    maxPortfolioExposure: z.number().positive().max(0.5).default(0.2),
    maxAssetExposure: z.number().positive().max(0.25).default(0.1),
    maxTradeNotional: decimal
      .refine(
        (v) => new Decimal(v).gt(0) && new Decimal(v).lte(1000),
        "Notional must be positive and at most 1000 USD",
      )
      .default("100"),
    maxConcurrentPositions: z.number().int().min(1).max(10).default(3),
    slippageBps: z.number().int().min(1).max(100).default(30),
    maxPriceImpact: z.number().positive().max(0.01).default(0.005),
    minimumLiquidity: decimal
      .refine(
        (v) => new Decimal(v).gte(10000),
        "Liquidity floor must be at least 10000 USD",
      )
      .default("50000"),
    maxNetworkFee: decimal
      .refine(
        (v) => new Decimal(v).gt(0) && new Decimal(v).lte(10),
        "Network fee ceiling must be positive and at most 10 USD",
      )
      .default("2"),
    maxDrawdown: z.number().positive().max(0.2).default(0.1),
    cooldownSeconds: z.number().int().min(60).max(86400).default(300),
  })
  .strict();
export const preferencesSchema = z
  .object({
    language: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .default("en"),
    timezone: z
      .string()
      .max(80)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      })
      .default("UTC"),
    currency: z.enum(["USD", "INR", "EUR"]).default("USD"),
    theme: z.enum(["dark", "system"]).default("dark"),
  })
  .strict();
export const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).default("Trader"),
    preferences: preferencesSchema.default(() => preferencesSchema.parse({})),
    tradingProfile: z
      .object({
        experienceLevel: z
          .enum(["beginner", "intermediate", "advanced", "unspecified"])
          .default("unspecified"),
        riskAppetite: z
          .enum(["conservative", "balanced", "unspecified"])
          .default("conservative"),
        preferredAssets: z
          .array(z.string().regex(/^[A-Z0-9_]{2,20}$/))
          .max(20)
          .default([]),
        restrictedAssets: z
          .array(z.string().regex(/^[A-Z0-9_]{2,20}$/))
          .max(20)
          .default([]),
        preferredTimeframes: z
          .array(z.enum(["1h", "4h", "1d"]))
          .max(3)
          .default(["1h"]),
        tradingStyle: z.string().max(100).default("unspecified"),
      })
      .strict()
      .default(() => ({
        experienceLevel: "unspecified" as const,
        riskAppetite: "conservative" as const,
        preferredAssets: [],
        restrictedAssets: [],
        preferredTimeframes: ["1h" as const],
        tradingStyle: "unspecified",
      })),
    riskProfile: riskSchema.default(() => riskSchema.parse({})),
  })
  .strict();
export const specSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().max(1500).default(""),
    type: z.enum(["trading", "research", "news_monitor", "market_monitor"]),
    configuration: z
      .object({
        assets: z
          .array(z.string().regex(/^[A-Z0-9_]{2,20}$/))
          .min(1)
          .max(10),
        timeframes: z
          .array(z.enum(["1h", "4h", "1d"]))
          .min(1)
          .max(3)
          .default(["1h"]),
        strategies: z.array(strategyId).max(5),
        strategyParameters: z
          .partialRecord(
            strategyId,
            z
              .object({
                fast_period: z.number().int().min(5).max(30).optional(),
                slow_period: z.number().int().min(20).max(60).optional(),
                rsi_entry: z.number().min(45).max(75).optional(),
                rsi_exit: z.number().min(20).max(50).optional(),
                volume_ratio: z.number().min(0.8).max(3).optional(),
                reversion_rsi: z.number().min(15).max(40).optional(),
                max_trend_distance: z.number().min(0.005).max(0.05).optional(),
                stop_atr_multiple: z.number().min(1).max(5).optional(),
                cooldown_seconds: z
                  .number()
                  .int()
                  .min(60)
                  .max(86400)
                  .optional(),
                breakout_lookback: z.number().int().min(10).max(60).optional(),
                breakout_atr_buffer: z.number().min(0).max(1).optional(),
                trend_min_slope: z.number().min(0).max(0.02).optional(),
              })
              .strict()
              .refine(
                (p) => (p.fast_period ?? 12) < (p.slow_period ?? 26),
                "Fast period must be smaller than slow period",
              ),
          )
          .default({}),
        selectionWeights: z
          .object({
            feature_weight: z.number().min(0).max(1).default(0.45),
            signal_weight: z.number().min(0).max(1).default(0.25),
            performance_weight: z.number().min(0).max(1).default(0.15),
            cost_weight: z.number().min(0).max(1).default(0.1),
            context_weight: z.number().min(0).max(0.1).default(0.05),
          })
          .strict()
          .refine(
            (w) => Object.values(w).reduce((a, b) => a + b, 0) > 0,
            "Weights require a positive sum",
          )
          .default(() => ({
            feature_weight: 0.45,
            signal_weight: 0.25,
            performance_weight: 0.15,
            cost_weight: 0.1,
            context_weight: 0.05,
          })),
        monitoringInterval: z.number().int().min(60).max(86400).default(300),
        selectionMode: z.enum(["dominant", "consensus"]).default("dominant"),
        minimumStrategyHoldSeconds: z
          .number()
          .int()
          .min(300)
          .max(604800)
          .default(1800),
        strategySwitchCooldown: z
          .number()
          .int()
          .min(60)
          .max(86400)
          .default(600),
        marketProvider: z.enum(["fixture", "coinbase"]).default("fixture"),
        newsProvider: z
          .enum(["fixture", "cryptocurrency.cv"])
          .default("fixture"),
      })
      .strict(),
    riskPolicy: riskSchema,
    permissions: z
      .object({
        readMarketData: z.literal(true),
        readPortfolio: z.boolean().default(false),
        generateSignals: z.boolean(),
        executeTrades: z.boolean().default(false),
        modifyRiskSettings: z.literal(false),
      })
      .strict(),
    execution: z
      .object({
        mode: z.enum(["SIMULATION", "PAPER", "LIVE"]).default("SIMULATION"),
        template: z.literal("krono-python-v1"),
        cpu: z.union([z.literal(256), z.literal(512)]).default(256),
        memoryMiB: z
          .union([z.literal(512), z.literal(1024), z.literal(2048)])
          .default(1024),
        maxRuntimeSeconds: z.number().int().min(300).max(86400).default(3600),
        idleShutdownSeconds: z.number().int().min(300).max(86400).default(1800),
        automaticSimulationFills: z.boolean().default(false),
        requireModelReview: z.boolean().default(true),
      })
      .strict(),
    coordination: z
      .object({
        publishOpportunities: z.boolean().default(false),
        researchAgentIds: z.array(idSchema).max(5).default([]),
      })
      .strict()
      .default({ publishOpportunities: false, researchAgentIds: [] }),
  })
  .strict()
  .superRefine((s, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (
      s.type !== "trading" &&
      (s.permissions.executeTrades || s.execution.automaticSimulationFills)
    )
      reject("Monitoring and research agents cannot trade");
    if (s.type === "trading" && !s.configuration.strategies.length)
      reject("A trading agent needs at least one strategy");
    if (s.execution.mode !== "SIMULATION")
      reject(
        "Only explicitly disclosed simulated fills are supported; HSKSwap live and exchange paper execution are not verified",
      );
    if (s.execution.automaticSimulationFills && !s.permissions.executeTrades)
      reject(
        "Automatic fills require the explicit simulation execution permission",
      );
    if (
      s.configuration.assets.length !== new Set(s.configuration.assets).size ||
      s.configuration.strategies.length !==
        new Set(s.configuration.strategies).size
    )
      reject("Duplicate assets or strategies");
    if (s.riskPolicy.maxAssetExposure > s.riskPolicy.maxPortfolioExposure)
      reject("Asset exposure cannot exceed portfolio exposure");
    if (s.execution.idleShutdownSeconds > s.execution.maxRuntimeSeconds)
      reject("Idle shutdown cannot exceed runtime budget");
    if (s.execution.cpu === 512 && s.execution.memoryMiB === 512)
      reject(
        "512 CPU units require at least 1024 MiB in the approved Fargate template",
      );
    if (
      Number(s.riskPolicy.maxTradeNotional) <= 0 ||
      Number(s.riskPolicy.maxTradeNotional) > 1000
    )
      reject("Trade notional must be positive and at most 1000 USD");
  });
export type AgentSpec = z.infer<typeof specSchema>;
export type Profile = z.infer<typeof profileSchema>;
export const deploymentStates = [
  "DRAFT",
  "VALIDATING",
  "APPROVAL_REQUIRED",
  "PROVISIONING",
  "DEPLOYING",
  "HEALTH_CHECK",
  "RUNNING",
  "PAUSED",
  "STOPPING",
  "STOPPED",
  "FAILED",
  "TERMINATED",
] as const;
export type DeploymentState = (typeof deploymentStates)[number];
export interface Agent {
  origin: "KRONO_MANAGED" | "USER_CREATED";
  id: string;
  ownerId: string;
  specification: AgentSpec;
  state: DeploymentState;
  configurationVersion: number;
  deploymentVersion: number;
  previousVersion?: number;
  createdAt: string;
  updatedAt: string;
  deployment?: Deployment;
  configurationState?:
    "DRAFT" | "VALIDATING" | "APPROVAL_REQUIRED" | "APPROVED";
  terminationRequested?: boolean;
}
export interface Deployment {
  version?: number;
  id: string;
  stackName: string;
  serviceArn?: string;
  taskDefinitionArn?: string;
  workflowArn?: string;
  imageVersion: string;
  configurationVersion: number;
  startedAt: string;
  expiresAt: number;
  lastError?: string;
}
export interface Principal {
  userId: string;
  username: string;
  accessToken?: string;
}
export interface RecordItem<T = unknown> {
  id: string;
  version: number;
  data: T;
  updatedAt: string;
}
export const messageSchema = z
  .object({ message: z.string().trim().min(1).max(8000), requestId: idSchema })
  .strict();
export const confirmationSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledgement: z.literal("DEPLOY_SIMULATION"),
  })
  .strict();
