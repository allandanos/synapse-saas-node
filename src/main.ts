import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import express from "express";
import { ClsMiddleware } from "nestjs-cls";
import { AppModule, clsMiddlewareOptions } from "./app.module";
import { prepareDatabase } from "./bootstrap";
import { SETTINGS, type Settings } from "./core/config";
import { bodyParseProblemMiddleware } from "./core/validation";

export const EXPOSED_HEADERS = ["X-Request-Id", "Retry-After", "Content-Disposition", "X-Total-Count"];

/** Provider webhooks are signed over the exact bytes sent, so this path never reaches the JSON parser. */
export const RAW_BODY_PATH = "/v1/billing/webhooks/:provider";

/** Wire the HTTP layer the same way in production and in supertest (create the app with `bodyParser: false`). */
export function configureHttp(app: NestExpressApplication, settings: Settings): void {
  app.use(new ClsMiddleware(clsMiddlewareOptions).use);
  app.use(RAW_BODY_PATH, express.raw({ type: "*/*", limit: "1mb" }));
  app.useBodyParser("json");
  app.useBodyParser("urlencoded", { extended: true });
  app.use(bodyParseProblemMiddleware());
  app.use(cookieParser());
  app.enableCors({ origin: [...settings.corsOrigins], credentials: true, exposedHeaders: EXPOSED_HEADERS });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["log", "warn", "error"], bodyParser: false });
  const settings = app.get<Settings>(SETTINGS);
  configureHttp(app, settings);
  app.enableShutdownHooks();
  await prepareDatabase(app);
  await app.listen(settings.PORT);
}

if (require.main === module) void bootstrap();
