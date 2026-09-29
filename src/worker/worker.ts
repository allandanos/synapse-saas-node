import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { prepareDatabase } from "../bootstrap";

/**
 * `pnpm worker` — the jobs without the HTTP listener, for a deployment that
 * scales the API and the worker separately (set `SYNAPSE_WORKER_ENABLED=false`
 * on the API processes so only this one holds the cadence).
 */
async function main(): Promise<void> {
  process.env.SYNAPSE_WORKER_ENABLED = process.env.SYNAPSE_WORKER_ENABLED ?? "true";
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  app.enableShutdownHooks();
  await prepareDatabase(app);
  new Logger("worker").log("worker started");
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
