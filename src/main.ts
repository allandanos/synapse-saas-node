import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import express from "express";
import { ClsMiddleware } from "nestjs-cls";
import { AppModule, clsMiddlewareOptions } from "./app.module";
import { prepareDatabase } from "./bootstrap";
import { SETTINGS, type Settings } from "./core/config";
import { RateLimiter } from "./core/rate-limiter";
import { bodyParseProblemMiddleware } from "./core/validation";
import { AuthRateLimitMiddleware } from "./identity/rate-limit/auth-rate-limit.middleware";


export const EXPOSED_HEADERS = ["X-Request-Id", "Retry-After", "Content-Disposition", "X-Total-Count"];

/** Provider webhooks are signed over the exact bytes sent, so this path never reaches the JSON parser. */
export const RAW_BODY_PATH = "/v1/billing/webhooks/:provider";

/** Wire the HTTP layer the same way in production and in supertest (create the app with `bodyParser: false`). */
export function configureHttp(app: NestExpressApplication, settings: Settings): void {
  const authLimit = new AuthRateLimitMiddleware(app.get(RateLimiter), settings);
  app.use(new ClsMiddleware(clsMiddlewareOptions).use);
  app.use(RAW_BODY_PATH, express.raw({ type: "*/*", limit: "1mb" }));
  // The IP bucket costs an attempt even for a body the parser will reject.
  app.use(authLimit.ipPhase());
  app.useBodyParser("json");
  app.useBodyParser("urlencoded", { extended: true });
  app.use(bodyParseProblemMiddleware());
  // The identity bucket needs the parsed body (see the middleware's docstring).
  app.use(authLimit.identityPhase());
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
