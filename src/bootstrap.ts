import { type INestApplicationContext, Logger } from "@nestjs/common";
import { SystemSeeder } from "./authorization/system-seed";
import { SETTINGS, type Settings } from "./core/config";
import { Database, RoleIsolationMismatchError } from "./core/db/database";
import { MigrationRunner } from "./core/db/migrations";
import { PlatformAdminBootstrap } from "./identity/platform-admin.bootstrap";

const logger = new Logger("bootstrap");

/**
 * Everything that must be true before the first request: migrations applied
 * (SYNAPSE_MIGRATE_ON_START), the RLS posture matches the connected role,
 * the catalog + system roles are seeded (SYNAPSE_SEED_ON_START), and the
 * bootstrap platform admin exists. `pnpm migrate` / `pnpm seed` reuse the parts.
 */
export async function prepareDatabase(app: INestApplicationContext): Promise<void> {
  const settings = app.get<Settings>(SETTINGS);
  if (settings.SYNAPSE_MIGRATE_ON_START) await app.get(MigrationRunner).run();
  await assertIsolation(app.get(Database), settings);
  if (settings.SYNAPSE_SEED_ON_START) await app.get(SystemSeeder).seed();
  await app.get(PlatformAdminBootstrap).run();
}

/** A mismatch always refuses to boot; a transient DB failure only does so in production. */
async function assertIsolation(db: Database, settings: Settings): Promise<void> {
  try {
    await db.assertRoleMatchesIsolation();
  } catch (error) {
    logger.error(`db role isolation check failed: ${error instanceof Error ? error.message : String(error)}`);
    if (settings.isProduction || error instanceof RoleIsolationMismatchError) throw error;
  }
}
