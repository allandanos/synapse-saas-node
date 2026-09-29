import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { PlanCatalogPush } from "../billing/plan-catalog-push";
import { PlanCatalogSync } from "../subscriptions/catalog-sync";

const USAGE = `Usage: pnpm plans:sync [options]

  (no options)              Sync SYNAPSE_PLANS_FILE into the database
  --provider <name>         Also push the catalog to a billing provider
  --stripe                  Shorthand for --provider stripe
  --apply                   Actually write the remote products/prices (default: dry run)

The dry run needs no provider credentials: it only describes the diff.`;

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** `pnpm plans:sync` — the catalog into the database, and optionally on to a provider. */
async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const provider = argv.includes("--stripe") ? "stripe" : flagValue(argv, "--provider");
  const apply = argv.includes("--apply");

  process.env.SYNAPSE_WORKER_ENABLED = "false"; // a one-shot command never holds the job cadence
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  try {
    const r = await app.get(PlanCatalogSync).syncFromFile();
    console.log(`features +${r.features_added}, metrics +${r.metrics_added}, plans +${r.plans_added}/~${r.plans_updated}/archived ${r.plans_archived}`);
    if (!provider) return;
    for (const line of (await app.get(PlanCatalogPush).push(provider, { apply })).lines) console.log(line);
    if (!apply) console.log("Nothing was written remotely. Re-run with --apply.");
  } finally {
    await app.close();
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
