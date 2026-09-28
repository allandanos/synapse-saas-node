import { type INestApplicationContext, Logger } from "@nestjs/common";
import { SystemSeeder } from "./authorization/system-seed";
import { SETTINGS, type Settings } from "./core/config";
import { Database, RoleIsolationMismatchError } from "./core/db/database";
import { MigrationRunner } from "./core/db/migrations";
import { PlatformAdminBootstrap } from "./identity/platform-admin.bootstrap";
import { PlanCatalogSync } from "./subscriptions/catalog-sync";

const logger = new Logger("bootstrap");

/**
 * Everything that must be true before the first request: migrations applied
 * (SYNAPSE_MIGRATE_ON_START), the RLS posture matches the connected role,
 * the permission catalog + system roles are seeded (SYNAPSE_SEED_ON_START),
 * the plan catalog is synced (SYNAPSE_AUTO_SYNC_PLANS), and the bootstrap
 * platform admin exists. `pnpm migrate` / `pnpm seed` / `pnpm plans:sync` reuse the parts.
 */
export async function prepareDatabase(app: INestApplicationContext): Promise<void> {
  const settings = app.get<Settings>(SETTINGS);
  if (settings.SYNAPSE_MIGRATE_ON_START) await app.get(MigrationRunner).run();
  await assertIsolation(app.get(Database), settings);
  if (settings.SYNAPSE_SEED_ON_START) await app.get(SystemSeeder).seed();
  if (settings.SYNAPSE_AUTO_SYNC_PLANS) await syncPlans(app.get(PlanCatalogSync), settings);
  await app.get(PlatformAdminBootstrap).run();
}

/** An invalid or unreachable catalog is logged; only production refuses to boot (like the reference's lifespan). */
async function syncPlans(sync: PlanCatalogSync, settings: Settings): Promise<void> {
  try {
    await sync.syncFromFile();
  } catch (error) {
    logger.error(`plans auto-sync failed: ${error instanceof Error ? error.message : String(error)}`);
    if (settings.isProduction) throw error;
  }
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
