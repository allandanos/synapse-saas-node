import { Inject, Injectable, Logger } from "@nestjs/common";
import { CACHE_NAMESPACES, CacheRegistry } from "../core/cache/cache.registry";
import type { VersionedCache } from "../core/cache/versioned-cache";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import { FgaError, PermissionDeniedError, RoleNotFoundError, SystemRoleImmutableError } from "../core/errors";
import { RequestContext, type UserContext } from "../core/request-context";
import { FgaClient } from "./fga/client";
import { FgaSyncService, orgObject, userObject } from "./fga/sync";
import { relationFor } from "./fga/model";
import { unknownPermissions } from "./permissions";
import { RolesRepository, type RoleRow } from "./roles.repository";

export interface RoleRead {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
}

export function toRoleRead(row: RoleRow): RoleRead {
  return { id: row.id, key: row.key, name: row.name, description: row.description, is_system: row.is_system, permissions: row.permissions };
}

/**
 * The authorization engine. `requirePermission` is the seam every tenant route
 * asks.
 *
 * RBAC is always the source of truth for what a role MEANS: `permissionKeysFor`
 * (which feeds the user context, API-key bounding and audit) reads the
 * denormalised membership set whichever backend is active. The DECISION goes
 * through `userCan`, which is RBAC or OpenFGA (ADR 0009) —
 * `SYNAPSE_AUTHZ_BACKEND` switches the check, not the data model.
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);
  /** Effective permission set per (user, org). */
  private readonly permCache: VersionedCache;
  /** OpenFGA decisions, scoped on `{user}:{object}` so one bump drops them all. */
  private readonly fgaCache: VersionedCache;

  constructor(
    private readonly db: Database,
    private readonly roles: RolesRepository,
    private readonly context: RequestContext,
    private readonly fga: FgaSyncService,
    caches: CacheRegistry,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {
    this.permCache = caches.namespace(CACHE_NAMESPACES.PERM);
    this.fgaCache = caches.namespace(CACHE_NAMESPACES.FGA);
  }

  // ── Checks ──────────────────────────────────────────────────────────────────

  /** Effective permission set for (user, org): the active membership's keys, or nothing. Cached briefly. */
  async permissionKeysFor(userId: string, organizationId: string, tx?: Tx): Promise<ReadonlySet<string>> {
    const cacheKey = `${userId}:${organizationId}`;
    const [cached, version] = await this.permCache.getVersioned(cacheKey);
    // An empty set is never served from the cache (the reference's truthiness
    // check): the body would be "" and a miss is the cheaper answer anyway.
    if (cached) return new Set(cached.split(","));

    const read = async (t: Tx): Promise<ReadonlySet<string>> => new Set((await this.roles.permissionKeysForMember(t, userId, organizationId)) ?? []);
    const keys = tx ? await read(tx) : await this.db.transaction(read);
    // Store under the version seen at READ time: a bump in between must leave
    // the new version empty, not fill it with this (now stale) set.
    await this.permCache.set(cacheKey, [...keys].sort().join(","), version);
    return keys;
  }

  /**
   * The org-level permission check. rbac: the member's denormalised set.
   * openfga: ask the store (`user:<id>` `can_<perm>` `organization:<id>`).
   */
  userCan(userId: string, organizationId: string, permission: string, tx?: Tx): Promise<boolean> {
    if (this.settings.SYNAPSE_AUTHZ_BACKEND === "openfga") {
      return this.fgaAllowed(userId, permission, orgObject(organizationId), tx);
    }
    return this.permissionKeysFor(userId, organizationId, tx).then((keys) => keys.has(permission));
  }

  /**
   * Resource-level check (`project:manage` on project X). The RBAC backend
   * answers at organization level only — pass organization ids as
   * `objectType="organization"`; anything else needs the openfga backend.
   */
  userCanOn(userId: string, permission: string, objectType: string, objectId: string): Promise<boolean> {
    if (this.settings.SYNAPSE_AUTHZ_BACKEND === "openfga") {
      return this.fgaAllowed(userId, permission, `${objectType}:${objectId}`);
    }
    if (objectType !== "organization") {
      throw new Error("resource-level checks need the openfga backend; check the org instead");
    }
    return this.userCan(userId, objectId, permission);
  }

  /**
   * One OpenFGA decision, cached 30 s under the `{user}:{object}` scope (so a
   * membership change drops every permission at once). An outage is NEVER
   * cached: the fail mode decides — `closed` denies, `rbac` falls back for
   * organization objects only.
   */
  private async fgaAllowed(userId: string, permission: string, object: string, tx?: Tx): Promise<boolean> {
    const scope = `${userId}:${object}`;
    const [cached, token] = await this.fgaCache.getScoped(`${scope}:${permission}`, scope);
    if (cached !== null) return cached === "1";
    let allowed: boolean;
    try {
      allowed = await new FgaClient(this.settings).check(userObject(userId), relationFor(permission), object);
    } catch (error) {
      if (!(error instanceof FgaError)) throw error;
      if (this.settings.SYNAPSE_OPENFGA_FAIL_MODE === "rbac" && object.startsWith("organization:")) {
        this.logger.warn(`fga check failed, falling back to rbac (permission=${permission}): ${error.message}`);
        return (await this.permissionKeysFor(userId, object.slice("organization:".length), tx)).has(permission);
      }
      this.logger.error(`fga check failed closed (permission=${permission} object=${object}): ${error.message}`);
      return false;
    }
    await this.fgaCache.setScoped(`${scope}:${permission}`, allowed ? "1" : "0", token);
    return allowed;
  }

  /**
   * Check the bound principal against `permission` for the bound tenant and
   * bind the enriched user context (with its RBAC permission keys). 403 on deny.
   *
   * API-key principals authorise against the key's scopes, intersected with
   * what the creating user can exercise RIGHT NOW: demoting or removing the
   * creator shrinks (or kills) every key they minted. They never consult
   * OpenFGA — a key's authority is its scopes ∩ the creator's RBAC.
   */
  async requirePermission(permission: string): Promise<void> {
    const principal = this.context.requireUser();
    const tenant = this.context.requireTenant();
    if (principal.apiKeyScopes !== null) {
      await this.requireApiKeyPermission(principal, permission, tenant.organizationId);
      return;
    }
    if (principal.isPlatformAdmin) {
      this.context.setUser({ ...principal, permissionKeys: new Set(["*"]) });
      return;
    }
    const keys = await this.permissionKeysFor(principal.userId, tenant.organizationId);
    if (!(await this.userCan(principal.userId, tenant.organizationId, permission))) {
      throw new PermissionDeniedError(`This action requires the '${permission}' permission`, { permission });
    }
    this.context.setUser({ ...principal, permissionKeys: keys });
  }

  private async requireApiKeyPermission(principal: UserContext, permission: string, organizationId: string): Promise<void> {
    const extras = { permission, auth: "api_key" };
    if (!principal.apiKeyScopes?.has(permission)) {
      throw new PermissionDeniedError(`API key lacks the '${permission}' scope`, extras);
    }
    const creatorId = principal.apiKeyCreatorId;
    if (creatorId === null) {
      throw new PermissionDeniedError("API key has no recorded creator to bound its authority", { ...extras, reason: "unbounded_key" });
    }
    await this.db.transaction(async (tx) => {
      const creator = await this.roles.userState(tx, creatorId);
      if (!creator || !creator.is_active) {
        throw new PermissionDeniedError("API key creator is no longer active", { ...extras, reason: "creator_inactive" });
      }
      if (creator.is_platform_admin) return;
      const creatorKeys = await this.permissionKeysFor(creatorId, organizationId, tx);
      if (!creatorKeys.has(permission)) {
        throw new PermissionDeniedError(`API key creator no longer holds the '${permission}' permission`, {
          ...extras,
          reason: "creator_lacks_permission",
        });
      }
    });
  }

  // ── Invalidation ────────────────────────────────────────────────────────────

  /**
   * Drop the cached permissions and OpenFGA decisions for one (user, org) and
   * queue the member's tuple resync.
   *
   * Bumped twice on purpose: NOW, so the rest of this request recomputes, and
   * again after the commit, so no concurrent reader caches the pre-commit rows
   * under the new version for a whole TTL.
   */
  async invalidateUserPerms(tx: Tx, userId: string, organizationId: string): Promise<void> {
    const permKey = `${userId}:${organizationId}`;
    const fgaKey = `${userId}:${orgObject(organizationId)}`;
    await this.permCache.bump(permKey);
    tx.deferBump(this.permCache, permKey);
    await this.fgaCache.bump(fgaKey);
    tx.deferBump(this.fgaCache, fgaKey);
    await this.fga.queue(tx, organizationId, userId);
  }

  /** Every member of an org (custom-role edits change what a role means). */
  async invalidateOrgPerms(tx: Tx, organizationId: string): Promise<void> {
    const rows = await tx.rows<{ user_id: string }>(`SELECT user_id FROM memberships WHERE organization_id = $1 AND user_id IS NOT NULL`, [
      organizationId,
    ]);
    for (const row of rows) await this.invalidateUserPerms(tx, row.user_id, organizationId);
  }

  // ── Role management ─────────────────────────────────────────────────────────

  listRoles(organizationId: string): Promise<RoleRead[]> {
    return this.db.transaction(async (tx) => (await this.roles.listForOrganization(tx, organizationId)).map(toRoleRead));
  }

  createCustomRole(input: {
    organizationId: string;
    key: string;
    name: string;
    description: string | null;
    permissions: string[];
  }): Promise<RoleRead> {
    this.assertKnown(input.permissions);
    return this.db.transaction(async (tx) => {
      const id = await this.roles.insert(tx, {
        organizationId: input.organizationId,
        key: input.key,
        name: input.name,
        description: input.description,
        isSystem: false,
      });
      await this.roles.replacePermissions(tx, id, input.permissions);
      return toRoleRead(await this.mustFind(tx, id));
    });
  }

  updateCustomRole(
    roleId: string,
    organizationId: string,
    patch: { name?: string; description?: string | null; permissions?: string[] },
  ): Promise<RoleRead> {
    if (patch.permissions !== undefined) this.assertKnown(patch.permissions);
    return this.db.transaction(async (tx) => {
      await this.scopedCustomRole(tx, roleId, organizationId);
      await this.roles.update(tx, roleId, { name: patch.name, description: patch.description });
      if (patch.permissions !== undefined) {
        await this.roles.replacePermissions(tx, roleId, patch.permissions);
        // Refresh the denormalised permission set of every member holding this role
        for (const membershipId of await this.roles.membershipIdsHoldingRole(tx, roleId)) {
          await this.roles.recomputeMembershipPermissions(tx, membershipId);
        }
      }
      await this.invalidateOrgPerms(tx, organizationId);
      return toRoleRead(await this.mustFind(tx, roleId));
    });
  }

  deleteCustomRole(roleId: string, organizationId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      await this.scopedCustomRole(tx, roleId, organizationId);
      const holders = await this.roles.membershipIdsHoldingRole(tx, roleId);
      await this.roles.delete(tx, roleId);
      for (const membershipId of holders) await this.roles.recomputeMembershipPermissions(tx, membershipId);
      await this.invalidateOrgPerms(tx, organizationId);
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private assertKnown(permissions: readonly string[]): void {
    const unknown = unknownPermissions(permissions);
    if (unknown.length > 0) {
      throw new PermissionDeniedError(`Unknown permissions: ${JSON.stringify(unknown)}`, { unknown });
    }
  }

  /** The org's own custom role, or 404 (system roles have no org ⇒ 404 too, like the reference). */
  private async scopedCustomRole(tx: Tx, roleId: string, organizationId: string): Promise<RoleRow> {
    const role = await this.roles.findById(tx, roleId);
    if (!role || role.organization_id !== organizationId) throw new RoleNotFoundError("Role not found");
    if (role.is_system) throw new SystemRoleImmutableError("System roles cannot be modified");
    return role;
  }

  private async mustFind(tx: Tx, roleId: string): Promise<RoleRow> {
    const role = await this.roles.findById(tx, roleId);
    if (!role) throw new RoleNotFoundError("Role not found");
    return role;
  }
}
