import { Injectable, Logger } from "@nestjs/common";
import { Database, type Tx } from "../core/db/database";
import { PERMISSIONS, SYSTEM_ROLES } from "./permissions";
import { RolesRepository } from "./roles.repository";

/**
 * System seed: permission catalog + system roles. Idempotent — safe on every
 * boot (`pnpm seed` runs the same function). System-role permissions are
 * append-only here; removals are deliberate catalog changes done by migration.
 */
@Injectable()
export class SystemSeeder {
  private readonly logger = new Logger(SystemSeeder.name);

  constructor(
    private readonly db: Database,
    private readonly roles: RolesRepository,
  ) {}

  async seed(): Promise<{ permissions: number; system_roles: number }> {
    const summary = await this.db.transaction((tx) => this.seedIn(tx));
    this.logger.log(`system seeded: ${summary.permissions} permissions, ${summary.system_roles} system roles`);
    return summary;
  }

  async seedIn(tx: Tx): Promise<{ permissions: number; system_roles: number }> {
    const existing = await this.roles.existingPermissionKeys(tx);
    for (const permission of PERMISSIONS) {
      if (!existing.has(permission.key)) await this.roles.insertPermission(tx, permission);
    }
    const systemRoles = new Map((await this.roles.systemRoles(tx)).map((role) => [role.key, role]));
    for (const [key, definition] of Object.entries(SYSTEM_ROLES)) {
      let role = systemRoles.get(key);
      if (!role) {
        const id = await this.roles.insert(tx, {
          organizationId: null,
          key,
          name: definition.name,
          description: definition.description,
          isSystem: true,
        });
        role = { id, organization_id: null, key, name: definition.name, description: definition.description, is_system: true, permissions: [] };
      }
      const held = new Set(role.permissions);
      const missing = definition.permissions.filter((p) => !held.has(p));
      if (missing.length > 0) await this.roles.addMissingPermissions(tx, role.id, missing);
    }
    return { permissions: PERMISSIONS.length, system_roles: Object.keys(SYSTEM_ROLES).length };
  }
}
