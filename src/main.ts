import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadSettings } from "./core/config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });
  app.enableShutdownHooks();
  await app.listen(loadSettings().PORT);
}

void bootstrap();
