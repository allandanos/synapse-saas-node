import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { SystemSeeder } from "../authorization/system-seed";
import { PlatformAdminBootstrap } from "../identity/platform-admin.bootstrap";
import { PlanCatalogSync } from "../subscriptions/catalog-sync";

/** `pnpm seed` — permission catalog + system roles (idempotent), the plan catalog, and the bootstrap platform admin. */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  try {
    const summary = await app.get(SystemSeeder).seed();
    const plans = await app.get(PlanCatalogSync).syncFromFile();
    const admin = await app.get(PlatformAdminBootstrap).run();
    console.log(
      `seeded ${summary.permissions} permissions, ${summary.system_roles} system roles; plans: +${plans.plans_added} new, ~${plans.plans_updated} updated; platform admin: ${admin}`,
    );
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
