import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Database } from "../core/db/database";
import { EntitlementNotFoundError } from "../core/errors";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import { PlatformAdminGuard } from "../tenancy/platform-admin.guard";
import { TenantGuard } from "../tenancy/tenant.guard";
import { GrantRequest } from "./entitlements.dto";
import { EntitlementsService } from "./entitlements.service";
import type { EffectiveEntitlementsRead } from "./resolver";

/** Tenant read of the effective set. */
@Controller("v1/entitlements")
@UseGuards(TenantGuard)
export class EntitlementsController {
  constructor(
    private readonly db: Database,
    private readonly context: RequestContext,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get()
  async effective(): Promise<EffectiveEntitlementsRead> {
    const organizationId = this.context.requireTenant().organizationId;
    return (await this.db.transaction((tx) => this.entitlements.effectiveForOrg(tx, organizationId))).toRead();
  }
}

/**
 * Operator surface (ADR 0008): grants are a platform action, never a tenant
 * one — a tenant holding `entitlement:manage` could grant itself `sso` or
 * raise its own limits, so no tenant role has it and these routes are
 * platform-admin only (tenants get 404: the surface is invisible).
 */
@Controller("v1/admin/orgs/:orgId/entitlements")
@UseGuards(PlatformAdminGuard)
export class AdminEntitlementsController {
  constructor(
    private readonly db: Database,
    private readonly context: RequestContext,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get()
  async effective(@Param("orgId", UuidPipe) orgId: string): Promise<EffectiveEntitlementsRead> {
    return (await this.db.transaction((tx) => this.entitlements.effectiveForOrg(tx, orgId))).toRead();
  }

  @Post("grants")
  @HttpCode(201)
  async grant(@Param("orgId", UuidPipe) orgId: string, @Body() body: GrantRequest): Promise<{ id: string; feature_key: string; source: string }> {
    const user = this.context.requireUser();
    const row = await this.db.transaction((tx) =>
      this.entitlements.grant(tx, orgId, {
        featureKey: body.feature_key,
        source: body.source,
        enabled: body.enabled ?? true,
        durationDays: body.duration_days ?? null,
        note: body.note ?? null,
        limitValue: body.limit_value ?? null,
        createdByUserId: user.userId,
      }),
    );
    return { id: row.id, feature_key: row.feature_key, source: row.source };
  }

  @Delete("grants/:grantId")
  @HttpCode(204)
  revoke(@Param("orgId", UuidPipe) orgId: string, @Param("grantId", UuidPipe) grantId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      const row = await this.entitlements.get(tx, grantId);
      if (row.organization_id !== orgId) throw new EntitlementNotFoundError("Grant not found for this organization");
      await this.entitlements.revoke(tx, grantId);
    });
  }
}
