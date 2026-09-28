import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { SystemSeeder } from "../authorization/system-seed";
import { PlatformAdminBootstrap } from "../identity/platform-admin.bootstrap";

/** `pnpm seed` — permission catalog + system roles (idempotent) and the bootstrap platform admin. */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  try {
    const summary = await app.get(SystemSeeder).seed();
    const admin = await app.get(PlatformAdminBootstrap).run();
    console.log(`seeded ${summary.permissions} permissions, ${summary.system_roles} system roles; platform admin: ${admin}`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
