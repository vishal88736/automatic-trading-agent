import {
  profileSchema,
  type Principal,
  type Profile,
} from "../domain/schemas.js";
import { conflict } from "../domain/errors.js";
import type { TenantStore } from "../storage/tenant-store.js";

export class ProfileService {
  constructor(private store: TenantStore) {}
  async syncIdentity(
    p: Principal,
    identity: { email: string; displayName: string; emailVerified: boolean },
  ) {
    const current = await this.store.get<Record<string, unknown>>(
      p,
      "IDENTITY",
      "self",
    );
    await this.store.commit(
      p,
      [
        {
          kind: "IDENTITY",
          id: "self",
          expectedVersion: current?.version ?? 0,
          data: {
            ...identity,
            createdAt: current?.data.createdAt ?? new Date().toISOString(),
            lastLogin: new Date().toISOString(),
          },
        },
      ],
      "identity.session.verified",
    );
    if (!(await this.store.get(p, "PROFILE", "self"))) {
      await this.store.commit(
        p,
        [
          {
            kind: "PROFILE",
            id: "self",
            expectedVersion: 0,
            data: profileSchema.parse({
              displayName: identity.displayName || "Trader",
            }),
          },
        ],
        "profile.created.from_identity",
      );
    }
  }
  async get(p: Principal) {
    const current = await this.store.get<Profile>(p, "PROFILE", "self");
    if (current) return current;
    const data = profileSchema.parse({});
    try {
      await this.store.commit(
        p,
        [{ kind: "PROFILE", id: "self", expectedVersion: 0, data }],
        "profile.created",
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "CONFLICT") throw e;
    }
    return (await this.store.get<Profile>(p, "PROFILE", "self"))!;
  }
  async update(p: Principal, input: unknown, version: number) {
    const data = profileSchema.parse(input),
      prior = await this.get(p);
    if (prior.version !== version) throw conflict();
    await this.store.commit(
      p,
      [{ kind: "PROFILE", id: "self", expectedVersion: version, data }],
      "profile.updated",
      { fromVersion: version },
    );
    return this.get(p);
  }
}
