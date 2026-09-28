import { randomBytes } from "node:crypto";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import type { Request, Response } from "express";
import { ClsMiddlewareOptions, ClsModule, type ClsService } from "nestjs-cls";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { ProbeController } from "./api/probe.controller";
import { AuthorizationModule } from "./authorization/authorization.module";
import { RolesModule } from "./authorization/roles.module";
import { CoreModule } from "./core/core.module";
import { ProblemFilter } from "./core/problem.filter";
import { ProblemValidationPipe } from "./core/validation";
import { IdentityModule } from "./identity/identity.module";
import { TenancyModule } from "./tenancy/tenancy.module";

export const REQUEST_ID_HEADER = "X-Request-Id";

function inboundRequestId(req: Request): string {
  const raw = req.headers["x-request-id"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length <= 64 ? value : `req_${randomBytes(8).toString("hex")}`;
}

/**
 * The request context: honours an inbound X-Request-Id, mints one otherwise,
 * echoes it on every response. Mounted manually (see `configureHttp`) so it
 * wraps the body parsers too — a malformed body still gets a correlated problem.
 */
export const clsMiddlewareOptions: ClsMiddlewareOptions = {
  mount: false,
  generateId: true,
  idGenerator: inboundRequestId,
  setup: (cls: ClsService, _req: Request, res: Response) => {
    res.setHeader(REQUEST_ID_HEADER, cls.getId());
  },
};

@Module({
  imports: [
    ClsModule.forRoot({ global: true, middleware: clsMiddlewareOptions }),
    CoreModule,
    AuthorizationModule,
    TenancyModule,
    RolesModule,
    ApiKeysModule,
    IdentityModule,
  ],
  controllers: [ProbeController],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_PIPE, useClass: ProblemValidationPipe },
  ],
})
export class AppModule {}
