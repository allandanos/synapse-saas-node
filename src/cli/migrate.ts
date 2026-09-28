import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { MigrationRunner } from "../core/db/migrations";

/** `pnpm migrate` — apply pending `migrations/*.sql` and exit. */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  try {
    const applied = await app.get(MigrationRunner).run();
    console.log(applied.length === 0 ? "migrations: up to date" : `migrations applied: ${applied.join(", ")}`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
