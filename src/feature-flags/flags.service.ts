import { Injectable } from "@nestjs/common";
import { CACHE_NAMESPACES, CacheRegistry } from "../core/cache/cache.registry";
import type { VersionedCache } from "../core/cache/versioned-cache";
import { Database, type Tx } from "../core/db/database";
import { ConflictError, FeatureFlagNotFoundError, InvalidRequestError } from "../core/errors";
import { inRollout } from "./buckets";
import { type FeatureFlagOverrideRow, type FlagRead, FlagsRepository, toFlagRead } from "./flags.repository";

export interface FlagScope {
  organizationId?: string | null;
  userId?: string | null;
}

/**
 * Feature flags are deployment toggles, not entitlements:
 * - entitlements answer "what did this org pay for?" (`FeatureGuard`)
 * - flags answer "is this code path on yet?" (rollouts, kill switches, betas)
 *
 * Resolution, first match wins: user override → org override → global default,
 * with a deterministic percentage rollout when one is configured. Unknown and
 * archived flags are off, so new code paths stay dark by default.
 *
 * Resolutions are cached under three scope versions (`all`, `org:<id>`,
 * `user:<id>`) so any of the three invalidations — a flag edit, an org
 * override, a user override — misses correctly.
 */
@Injectable()
export class FlagsService {
  private readonly cache: VersionedCache;

  constructor(
    private readonly db: Database,
    private readonly flags: FlagsRepository,
    caches: CacheRegistry,
  ) {
    this.cache = caches.namespace(CACHE_NAMESPACES.FLAGS);
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  isEnabled(organizationId: string | null, userId: string | null, flagKey: string): Promise<boolean> {
    return this.db.transaction((tx) => this.evaluate(tx, flagKey, { organizationId, userId }));
  }

  async evaluate(tx: Tx, flagKey: string, scope: FlagScope): Promise<boolean> {
    const organizationId = scope.organizationId ?? null;
    const userId = scope.userId ?? null;
    const scopes = ["all", `org:${String(organizationId)}`, `user:${String(userId)}`];
    const cacheKey = `${flagKey}|${String(organizationId)}|${String(userId)}`;
    const [cached, token] = await this.cache.getScoped(cacheKey, ...scopes);
    if (cached !== null) return cached === "1";
    const enabled = await this.resolve(tx, flagKey, scope);
    await this.cache.setScoped(cacheKey, enabled ? "1" : "0", token);
    return enabled;
  }

  private async resolve(tx: Tx, flagKey: string, scope: FlagScope): Promise<boolean> {
    const flag = await this.flags.findByKey(tx, flagKey);
    if (!flag) return false; // unknown flags are off

    // Most specific override wins.
    if (scope.userId) {
      const override = await this.flags.findOverride(tx, flagKey, { userId: scope.userId });
      if (override) return override.enabled;
    }
    if (scope.organizationId) {
      const override = await this.flags.findOverride(tx, flagKey, { organizationId: scope.organizationId });
      if (override) return override.enabled;
    }

    // Global default, possibly gated by a deterministic rollout.
    if (flag.rollout_percentage !== null) {
      const identifier = scope.userId ?? scope.organizationId ?? "anonymous";
      return inRollout(flagKey, identifier, flag.rollout_percentage);
    }
    return flag.enabled;
  }

  // ── Management (platform-admin surface) ─────────────────────────────────────

  async listFlags(): Promise<FlagRead[]> {
    return (await this.db.transaction((tx) => this.flags.listFlags(tx))).map(toFlagRead);
  }

  createFlag(input: { key: string; name: string; description?: string | null; enabled?: boolean; rollout_percentage?: number | null }): Promise<FlagRead> {
    return this.db.transaction(async (tx) => {
      if (await this.flags.findByKey(tx, input.key)) throw new ConflictError(`Flag '${input.key}' already exists`, { key: input.key });
      const row = await this.flags.insertFlag(tx, {
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        enabled: input.enabled ?? false,
        rolloutPercentage: input.rollout_percentage ?? null,
      });
      await this.invalidate(tx, "all");
      return toFlagRead(row);
    });
  }

  updateFlag(key: string, patch: { enabled?: boolean; rollout_percentage?: number }): Promise<FlagRead> {
    return this.db.transaction(async (tx) => {
      await this.requireFlag(tx, key);
      const row = await this.flags.updateFlag(tx, key, { enabled: patch.enabled, rolloutPercentage: patch.rollout_percentage });
      await this.invalidate(tx, "all");
      return toFlagRead(row);
    });
  }

  listOverrides(flagKey: string): Promise<FeatureFlagOverrideRow[]> {
    return this.db.transaction((tx) => this.flags.listOverrides(tx, flagKey));
  }

  /** Upsert: one override per scope, so re-posting the same scope rewrites it. */
  setOverride(flagKey: string, input: { organization_id?: string | null; user_id?: string | null; enabled: boolean; note?: string | null }): Promise<FeatureFlagOverrideRow> {
    return this.db.transaction(async (tx) => {
      await this.requireFlag(tx, flagKey);
      const organizationId = input.organization_id ?? null;
      const userId = input.user_id ?? null;
      // Defence in depth behind the DTO: a 422, not a not-found wearing the
      // wrong title (the reference used to raise FeatureFlagNotFoundError here).
      if ((organizationId === null) === (userId === null)) {
        throw new InvalidRequestError("Override requires exactly one of organization_id or user_id");
      }

      const existing = await this.flags.findOverride(tx, flagKey, { organizationId, userId });
      const row = existing
        ? await this.flags.updateOverride(tx, existing.id, { enabled: input.enabled, note: input.note ?? null })
        : await this.flags.insertOverride(tx, { flagKey, organizationId, userId, enabled: input.enabled, note: input.note ?? null });
      await this.bumpScope(tx, organizationId, userId);
      return row;
    });
  }

  deleteOverride(overrideId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      const row = await this.flags.findOverrideById(tx, overrideId);
      if (!row) throw new FeatureFlagNotFoundError("Override not found");
      await this.flags.deleteOverride(tx, overrideId);
      await this.bumpScope(tx, row.organization_id, row.user_id);
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async requireFlag(tx: Tx, key: string): Promise<void> {
    if (!(await this.flags.findByKey(tx, key))) throw new FeatureFlagNotFoundError(`Flag '${key}' not found`);
  }

  private async bumpScope(tx: Tx, organizationId: string | null, userId: string | null): Promise<void> {
    if (organizationId !== null) await this.invalidate(tx, `org:${organizationId}`);
    if (userId !== null) await this.invalidate(tx, `user:${userId}`);
  }

  /** Now (this request sees the change) and after commit (nobody caches pre-commit rows). */
  private invalidate(tx: Tx, scope: string): Promise<void> {
    return this.cache.invalidate(tx, scope);
  }
}
