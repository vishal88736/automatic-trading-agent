import { z } from "zod";
import type { Principal, Profile } from "../../domain/schemas.js";
import { idSchema, profileSchema, specSchema } from "../../domain/schemas.js";
import { AgentService } from "../../agents/agent.service.js";
import { ProfileService } from "../../profiles/profile.service.js";
import { bedrockSchema, validateOutput } from "./structured-output.js";
import { denied } from "../../domain/errors.js";
import type { ToolDefinition } from "./llm.interface.js";
import { digest } from "../../agents/agent.service.js";
import { randomUUID } from "node:crypto";

type Tool = {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (p: Principal, input: unknown) => Promise<unknown>;
};
export class ToolRegistry {
  private tools: Tool[];
  constructor(
    private agents: AgentService,
    private profiles: ProfileService,
  ) {
    this.tools = [
      {
        name: "inspect_managed_templates",
        description:
          "Read versioned KRONO-managed agent templates. These are templates, not deployed runtimes.",
        schema: z.object({}).strict(),
        run: (p) => agents.templates(p),
      },
      {
        name: "draft_from_template",
        description:
          "Create an owned draft from a registered KRONO-managed template. Does not deploy or enable trading.",
        schema: z
          .object({ templateId: z.string().regex(/^[a-z0-9-]{2,60}$/) })
          .strict(),
        run: async (p, input) => {
          const row = await agents.fromTemplate(
            p,
            (input as { templateId: string }).templateId,
          );
          return agents.preview(p, row.id);
        },
      },
      {
        name: "inspect_portfolio",
        description:
          "Read the combined actual recorded simulation snapshots. Missing or stale valuations stay unavailable.",
        schema: z.object({}).strict(),
        run: (p) => agents.portfolio(p),
      },
      {
        name: "inspect_agent_events",
        description:
          "Read recent actual agent workflow evidence, strategy rankings, risk decisions and simulation executions.",
        schema: z.object({ agentId: idSchema }).strict(),
        run: async (p, input) => {
          const row = await agents.get(
            p,
            (input as { agentId: string }).agentId,
          );
          return agents.runtime.events(p, row.data, 20);
        },
      },
      {
        name: "inspect_platform",
        description:
          "Retrieve the user's saved profile, agents and actual usage. Never contains wallet secrets.",
        schema: z.object({}).strict(),
        run: async (p) => ({
          profile: await profiles.get(p),
          agents: await agents.store.list(p, "AGENT", 50),
          usage: await agents.store.list(p, "USAGE", 7),
          limitations: [
            "HSKSwap live execution disabled",
            "Only simulation fills; AWS deployment status must be queried",
          ],
        }),
      },
      {
        name: "inspect_agent",
        description:
          "Retrieve actual deployment, health, portfolio and strategy state for an owned agent.",
        schema: z.object({ agentId: idSchema }).strict(),
        run: async (p, input) =>
          agents.status(p, (input as { agentId: string }).agentId),
      },
      {
        name: "create_agent_draft",
        description:
          "Persist a validated declarative agent draft. Does not provision, start, sign or deploy anything. Use existing risk/profile preferences; ask about missing requirements.",
        schema: specSchema,
        run: async (p, input) => {
          const a = await agents.create(p, input);
          return agents.preview(p, a.id);
        },
      },
      {
        name: "preview_deployment",
        description:
          "Retrieve the exact configuration and digest for human review. No deployment occurs.",
        schema: z.object({ agentId: idSchema }).strict(),
        run: async (p, input) =>
          agents.preview(p, (input as { agentId: string }).agentId),
      },
      {
        name: "propose_profile",
        description:
          "Propose a full user profile update after explaining it. Returns a pending consent action; never saves preferences without user approval.",
        schema: profileSchema,
        run: async (p, input) => {
          const prior = await profiles.get(p);
          return this.pending(p, "PROFILE_UPDATE", {
            profile: input,
            expectedVersion: prior.version,
          });
        },
      },
      {
        name: "propose_agent_update",
        description:
          "Validate a revised agent specification and return a version-bound pending review. Does not modify a running deployment.",
        schema: z
          .object({ agentId: idSchema, specification: specSchema })
          .strict(),
        run: async (p, input) => {
          const v = input as { agentId: string; specification: unknown },
            row = await agents.get(p, v.agentId);
          const spec = await agents.validate(p, v.specification);
          return this.pending(p, "AGENT_UPDATE", {
            agentId: v.agentId,
            specification: spec,
            expectedVersion: row.version,
          });
        },
      },
      {
        name: "propose_control",
        description:
          "Propose pause, resume, stop or restart for human confirmation. No action occurs until approval.",
        schema: z
          .object({
            agentId: idSchema,
            command: z.enum(["PAUSE", "RESUME", "STOP", "RESTART"]),
          })
          .strict(),
        run: async (p, input) => {
          const v = input as { agentId: string; command: string },
            row = await agents.get(p, v.agentId);
          return this.pending(p, "AGENT_CONTROL", {
            ...v,
            expectedVersion: row.version,
          });
        },
      },
    ];
  }
  definitions(): ToolDefinition[] {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: bedrockSchema(t.schema),
    }));
  }
  async call(p: Principal, name: string, input: unknown) {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw denied("Unregistered model tool");
    return tool.run(p, validateOutput(tool.schema, input));
  }
  async pending(p: Principal, type: string, payload: unknown) {
    const id = randomUUID(),
      data = {
        type,
        payload,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        state: "PENDING",
      },
      hash = digest(data);
    await this.agents.store.commit(
      p,
      [
        {
          kind: "ACTION",
          id,
          expectedVersion: 0,
          data: { ...data, digest: hash },
        },
      ],
      "action.proposed",
      { actionId: id, type },
    );
    return {
      actionId: id,
      ...data,
      digest: hash,
      requiresExplicitConfirmation: true,
    };
  }
  async approve(p: Principal, id: string, hash: string) {
    const row = await this.agents.store.get<{
      type: string;
      payload: Record<string, unknown>;
      state: string;
      expiresAt: number;
      digest: string;
    }>(p, "ACTION", id);
    if (
      !row ||
      row.data.state !== "PENDING" ||
      row.data.expiresAt < Date.now() / 1000 ||
      hash !== row.data.digest
    )
      throw denied("This approval expired or was already used");
    // Consume before mutation. Failed actions are reviewed again, never blindly replayed.
    await this.agents.store.commit(
      p,
      [
        {
          kind: "ACTION",
          id,
          expectedVersion: row.version,
          data: { ...row.data, state: "CONSUMED" },
        },
      ],
      "action.approved",
      { actionId: id, type: row.data.type },
    );
    const v = row.data.payload;
    if (row.data.type === "PROFILE_UPDATE")
      return this.agents.updateProfile(
        p,
        v.profile as Profile,
        Number(v.expectedVersion),
      );
    if (row.data.type === "AGENT_UPDATE")
      return this.agents.update(
        p,
        String(v.agentId),
        v.specification,
        Number(v.expectedVersion),
      );
    if (row.data.type === "AGENT_CONTROL")
      return this.agents.control(
        p,
        String(v.agentId),
        v.command as "PAUSE" | "RESUME" | "STOP" | "RESTART",
        Number(v.expectedVersion),
      );
    throw denied("Unknown pending action");
  }
}
