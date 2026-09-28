import { Injectable } from "@nestjs/common";
import { Database, type Tx } from "../core/db/database";
import { PermissionDeniedError, RoleNotFoundError, SystemRoleImmutableError } from "../core/errors";
import { RequestContext, type UserContext } from "../core/request-context";
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
 * The RBAC engine. `requirePermission` is the seam every tenant route asks;
 * today it reads the member's denormalised permission set (an OpenFGA-backed
 * check can replace it without touching callers — milestone 7).
 */
@Injectable()
export class AuthorizationService {
  constructor(
    private readonly db: Database,
    private readonly roles: RolesRepository,
    private readonly context: RequestContext,
  ) {}

  // ── Checks ──────────────────────────────────────────────────────────────────

  /** Effective permission set for (user, org): the active membership's keys, or nothing. */
  async permissionKeysFor(userId: string, organizationId: string, tx?: Tx): Promise<ReadonlySet<string>> {
    const read = async (t: Tx): Promise<ReadonlySet<string>> =>
      new Set((await this.roles.permissionKeysForMember(t, userId, organizationId)) ?? []);
    return tx ? read(tx) : this.db.transaction(read);
  }

  /**
   * Check the bound principal against `permission` for the bound tenant and
   * bind the enriched user context (with its permission keys). 403 on deny.
   *
   * API-key principals authorise against the key's scopes, intersected with
   * what the creating user can exercise RIGHT NOW: demoting or removing the
   * creator shrinks (or kills) every key they minted.
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
    if (!keys.has(permission)) {
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
      return toRoleRead(await this.mustFind(tx, roleId));
    });
  }

  deleteCustomRole(roleId: string, organizationId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      await this.scopedCustomRole(tx, roleId, organizationId);
      const holders = await this.roles.membershipIdsHoldingRole(tx, roleId);
      await this.roles.delete(tx, roleId);
      for (const membershipId of holders) await this.roles.recomputeMembershipPermissions(tx, membershipId);
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
