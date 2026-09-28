import { Controller, Get, HttpCode, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import type { Pool } from "pg";
import { PG_POOL, SETTINGS, type Settings } from "../core/config";

/** Milestone 1 slice of the contract: liveness, readiness, discovery. */
@Controller()
export class ProbeController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pick<Pool, "query">,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  @Get("healthz")
  healthz() {
    return { status: "ok" };
  }

  /** 200 only when every dependency answers; 503 otherwise (same body shape as the reference). */
  @Get("readyz")
  @HttpCode(200)
  async readyz(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, string> = {};
    try {
      await this.pool.query("SELECT 1");
      checks.database = "ok";
    } catch {
      checks.database = "error";
    }
    const ok = Object.values(checks).every((v) => v === "ok");
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "degraded", checks };
  }

  @Get("v1/meta")
  meta() {
    return {
      version: this.settings.SYNAPSE_VERSION,
      billing_provider: this.settings.SYNAPSE_BILLING_PROVIDER,
      identity_provider: this.settings.SYNAPSE_IDENTITY_PROVIDER,
      tenant_isolation: this.settings.SYNAPSE_TENANT_ISOLATION,
    };
  }
}
