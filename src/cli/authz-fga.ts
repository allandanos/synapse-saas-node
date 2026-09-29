import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { FgaClient } from "../authorization/fga/client";
import { buildModel, relationFor, renderDsl } from "../authorization/fga/model";
import { FgaSyncService, orgObject, userObject } from "../authorization/fga/sync";
import { SETTINGS, type Settings } from "../core/config";

const USAGE = `Usage: pnpm authz:fga -- <command>

  write-model [--create-store NAME] [--dsl]   Write the catalog-generated model to the store
  sync (--all | --org <id>)                   Converge OpenFGA tuples to the RBAC state
  check <user-id> <org-id> <permission>       Ask the store whether USER may exercise PERMISSION

Reads SYNAPSE_OPENFGA_URL / _STORE_ID / _MODEL_ID / _API_TOKEN.`;

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** `authz fga …` — model bootstrap, tuple sync and one-off checks (`cli.py`). */
async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  process.env.SYNAPSE_WORKER_ENABLED = "false"; // a one-shot command never holds the job cadence
  process.env.SYNAPSE_MIGRATE_ON_START = process.env.SYNAPSE_MIGRATE_ON_START ?? "false";
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["warn", "error"] });
  try {
    const settings = app.get<Settings>(SETTINGS);
    switch (command) {
      case "write-model": {
        if (rest.includes("--dsl")) {
          console.log(renderDsl());
          return;
        }
        const client = new FgaClient(settings);
        const storeName = flagValue(rest, "--create-store");
        if (storeName) client.storeId = await client.createStore(storeName);
        const modelId = await client.writeModel(buildModel());
        console.log(`store_id=${client.storeId}`);
        console.log(`authorization_model_id=${modelId}`);
        console.log("Set SYNAPSE_OPENFGA_STORE_ID / SYNAPSE_OPENFGA_MODEL_ID accordingly.");
        return;
      }
      case "sync": {
        const organizationId = flagValue(rest, "--org");
        if (!rest.includes("--all") && !organizationId) throw new Error("Pass --all or --org <id>");
        console.log(`synced ${String(await app.get(FgaSyncService).syncAll(organizationId))} membership(s)`);
        return;
      }
      case "check": {
        const [userId, organizationId, permission] = rest;
        if (!userId || !organizationId || !permission) throw new Error("Usage: check <user-id> <org-id> <permission>");
        const allowed = await new FgaClient(settings).check(userObject(userId), relationFor(permission), orgObject(organizationId));
        console.log(allowed ? "allowed" : "denied");
        if (!allowed) process.exitCode = 1;
        return;
      }
      default:
        throw new Error(`Unknown command '${command}'\n\n${USAGE}`);
    }
  } finally {
    await app.close();
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
