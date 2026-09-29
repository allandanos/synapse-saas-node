import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { CacheRegistry } from "../core/cache/cache.registry";
import { SETTINGS, type Settings } from "../core/config";
import { Database } from "../core/db/database";
import { Public } from "../identity/public.decorator";

/** Liveness, readiness, discovery — the milestone 1 slice of the contract. */
@Public()
@Controller()
export class ProbeController {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheRegistry,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  @Get("healthz")
  healthz(): { status: string } {
    return { status: "ok" };
  }

  /** 200 only when every dependency answers; 503 otherwise, so a readiness probe pulls a broken pod. */
  @Get("readyz")
  async readyz(@Res({ passthrough: true }) res: Response): Promise<{ status: string; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};
    try {
      await this.db.ping();
      checks.database = "ok";
    } catch (error) {
      checks.database = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    checks.redis = await this.cache.health();
    const ok = Object.values(checks).every((value) => value === "ok" || value === "not_configured");
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "error", checks };
  }

  @Get("v1/meta")
  meta(): Record<string, string> {
    return {
      framework: "synapse-saas",
      version: this.settings.SYNAPSE_VERSION,
      billing_provider: this.settings.SYNAPSE_BILLING_PROVIDER,
      identity_provider: this.settings.SYNAPSE_IDENTITY_PROVIDER,
      tenant_isolation: this.settings.SYNAPSE_TENANT_ISOLATION,
    };
  }
}
