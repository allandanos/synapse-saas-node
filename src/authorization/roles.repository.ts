import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface RoleRow {
  id: string;
  organization_id: string | null;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  /** Sorted permission keys. */
  permissions: string[];
}

const ROLE_SELECT = `
  SELECT r.id, r.organization_id, r.key, r.name, r.description, r.is_system,
         COALESCE(array_agg(p.key ORDER BY p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
  FROM roles r
  LEFT JOIN role_permissions rp ON rp.role_id = r.id
  LEFT JOIN permissions p ON p.id = rp.permission_id`;

/** Roles, permissions, and the denormalised `memberships.permission_keys` they feed. */
@Injectable()
export class RolesRepository {
  /** System roles + the org's custom roles, system first then by key. */
  listForOrganization(tx: Tx, organizationId: string): Promise<RoleRow[]> {
    return tx.rows<RoleRow>(
      `${ROLE_SELECT} WHERE r.organization_id = $1 OR r.organization_id IS NULL
       GROUP BY r.id ORDER BY r.is_system DESC, r.key ASC`,
      [organizationId],
    );
  }

  findById(tx: Tx, roleId: string): Promise<RoleRow | undefined> {
    return tx.one<RoleRow>(`${ROLE_SELECT} WHERE r.id = $1 GROUP BY r.id`, [roleId]);
  }

  /** A role visible to the org by key: the org's own or a system role. */
  findByKeyForOrganization(tx: Tx, key: string, organizationId: string): Promise<RoleRow | undefined> {
    return tx.one<RoleRow>(
      `${ROLE_SELECT} WHERE r.key = $1 AND (r.organization_id = $2 OR r.organization_id IS NULL)
       GROUP BY r.id ORDER BY r.is_system DESC LIMIT 1`,
      [key, organizationId],
    );
  }

  async insert(
    tx: Tx,
    role: { organizationId: string | null; key: string; name: string; description: string | null; isSystem: boolean },
  ): Promise<string> {
    const id = newUuid();
    await tx.query(
      `INSERT INTO roles (id, organization_id, key, name, description, is_system) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, role.organizationId, role.key, role.name, role.description, role.isSystem],
    );
    return id;
  }

  async update(tx: Tx, roleId: string, patch: { name?: string; description?: string | null }): Promise<void> {
    await tx.query(
      `UPDATE roles SET name = COALESCE($2, name), description = CASE WHEN $4 THEN $3 ELSE description END, updated_at = now()
       WHERE id = $1`,
      [roleId, patch.name ?? null, patch.description ?? null, patch.description !== undefined],
    );
  }

  /** Cascades to role_permissions and membership_roles through the schema's FKs. */
  async delete(tx: Tx, roleId: string): Promise<void> {
    await tx.query(`DELETE FROM roles WHERE id = $1`, [roleId]);
  }

  async replacePermissions(tx: Tx, roleId: string, permissionKeys: readonly string[]): Promise<void> {
    await tx.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    await tx.query(
      `INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = ANY($2::text[])`,
      [roleId, [...permissionKeys]],
    );
  }

  async addMissingPermissions(tx: Tx, roleId: string, permissionKeys: readonly string[]): Promise<void> {
    await tx.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions WHERE key = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [roleId, [...permissionKeys]],
    );
  }

  async membershipIdsHoldingRole(tx: Tx, roleId: string): Promise<string[]> {
    const rows = await tx.rows<{ membership_id: string }>(`SELECT membership_id FROM membership_roles WHERE role_id = $1`, [roleId]);
    return rows.map((r) => r.membership_id);
  }

  async attachToMembership(tx: Tx, membershipId: string, roleId: string): Promise<void> {
    await tx.query(`INSERT INTO membership_roles (membership_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [membershipId, roleId]);
  }

  async detachAllFromMembership(tx: Tx, membershipId: string): Promise<void> {
    await tx.query(`DELETE FROM membership_roles WHERE membership_id = $1`, [membershipId]);
  }

  /** Rebuild the denormalised permission set of one membership from its roles. */
  async recomputeMembershipPermissions(tx: Tx, membershipId: string): Promise<string[]> {
    const row = await tx.one<{ permission_keys: string[] }>(
      `UPDATE memberships m
       SET permission_keys = COALESCE((
             SELECT array_agg(DISTINCT p.key ORDER BY p.key)
             FROM membership_roles mr
             JOIN role_permissions rp ON rp.role_id = mr.role_id
             JOIN permissions p ON p.id = rp.permission_id
             WHERE mr.membership_id = m.id), '{}'),
           updated_at = now()
       WHERE m.id = $1
       RETURNING permission_keys`,
      [membershipId],
    );
    return row?.permission_keys ?? [];
  }

  async permissionKeysForMember(tx: Tx, userId: string, organizationId: string): Promise<string[] | undefined> {
    const row = await tx.one<{ permission_keys: string[] }>(
      `SELECT permission_keys FROM memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
      [organizationId, userId],
    );
    return row?.permission_keys;
  }

  async userState(tx: Tx, userId: string): Promise<{ is_active: boolean; is_platform_admin: boolean } | undefined> {
    return tx.one(`SELECT is_active, is_platform_admin FROM users WHERE id = $1`, [userId]);
  }

  async existingPermissionKeys(tx: Tx): Promise<Set<string>> {
    return new Set((await tx.rows<{ key: string }>(`SELECT key FROM permissions`)).map((r) => r.key));
  }

  async insertPermission(tx: Tx, p: { key: string; resource: string; action: string; description: string }): Promise<void> {
    await tx.query(`INSERT INTO permissions (id, key, resource, action, description) VALUES ($1, $2, $3, $4, $5)`, [
      newUuid(),
      p.key,
      p.resource,
      p.action,
      p.description,
    ]);
  }

  systemRoles(tx: Tx): Promise<RoleRow[]> {
    return tx.rows<RoleRow>(`${ROLE_SELECT} WHERE r.is_system GROUP BY r.id`);
  }
}
