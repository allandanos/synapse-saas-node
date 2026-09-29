import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { SystemSeeder } from "../authorization/system-seed";
import { SETTINGS, type Settings } from "../core/config";
import { DEV_PASSWORD, DEV_ROLE_USERS, DevSeeder } from "../seeds/dev-seed";
import { SeedsModule } from "../seeds/seeds.module";
import { PlanCatalogSync } from "../subscriptions/catalog-sync";

/** The dev seeder is not part of the served application graph — the CLI adds it. */
@Module({ imports: [AppModule, SeedsModule] })
class SeedDevModule {}

/**
 * `pnpm seed:dev` — the system seed and plan catalog first, then the demo org
 * and one user per system role. Refuses to run in production.
 */
async function main(): Promise<void> {
  process.env.SYNAPSE_WORKER_ENABLED = "false"; // a one-shot command never holds the job cadence
  const app = await NestFactory.createApplicationContext(SeedDevModule, { logger: ["log", "warn", "error"] });
  try {
    const settings = app.get<Settings>(SETTINGS);
    if (settings.isProduction) throw new Error("Refusing to seed demo data: SYNAPSE_ENV is production");

    const summary = await app.get(SystemSeeder).seed();
    const plans = await app.get(PlanCatalogSync).syncFromFile();
    const outcome = await app.get(DevSeeder).run();
    console.log(
      `seeded ${summary.permissions} permissions, ${summary.system_roles} system roles; plans: +${plans.plans_added} new, ~${plans.plans_updated} updated; dev data: ${outcome}`,
    );
    if (outcome === "seeded") {
      console.log(`Dev credentials: ${DEV_ROLE_USERS.map(([email]) => email.split("@")[0]).join("/")}@acme.example.com — all use ${DEV_PASSWORD}`);
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
