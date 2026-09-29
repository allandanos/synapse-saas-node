import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { PlanCatalogSync } from "../subscriptions/catalog-sync";

/** `pnpm plans:sync` — sync `SYNAPSE_PLANS_FILE` (config/plans.yaml) into the database and exit. */
async function main(): Promise<void> {
  process.env.SYNAPSE_WORKER_ENABLED = "false"; // a one-shot command never holds the job cadence
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  try {
    const r = await app.get(PlanCatalogSync).syncFromFile();
    console.log(`features +${r.features_added}, metrics +${r.metrics_added}, plans +${r.plans_added}/~${r.plans_updated}/archived ${r.plans_archived}`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
