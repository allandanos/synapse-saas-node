import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { PageQuery, sliceInMemory, TOTAL_COUNT_HEADER } from "../core/pagination";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import { PlatformAdminGuard } from "../tenancy/platform-admin.guard";
import { TenantGuard } from "../tenancy/tenant.guard";
import { FlagCreate, FlagUpdate, OverrideCreate } from "./flags.dto";
import type { FeatureFlagOverrideRow, FlagRead } from "./flags.repository";
import { FlagsService } from "./flags.service";

/**
 * Flag management is an operator surface (ADR 0008): defining a flag or
 * overriding it for somebody else is a deployment decision, so tenants get a
 * 404 here — the surface is invisible, never a 403 that confirms it exists.
 */
@Controller("v1/feature-flags")
@UseGuards(PlatformAdminGuard)
export class FeatureFlagsAdminController {
  constructor(private readonly flags: FlagsService) {}

  @Get()
  async list(@Query() page: PageQuery, @Res({ passthrough: true }) res: Response): Promise<FlagRead[]> {
    const { items, total } = sliceInMemory(await this.flags.listFlags(), page);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items;
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: FlagCreate): Promise<FlagRead> {
    return this.flags.createFlag(body);
  }

  @Patch(":key")
  update(@Param("key") key: string, @Body() body: FlagUpdate): Promise<FlagRead> {
    return this.flags.updateFlag(key, body);
  }

  @Get(":key/overrides")
  async listOverrides(@Param("key") key: string, @Query() page: PageQuery, @Res({ passthrough: true }) res: Response): Promise<FeatureFlagOverrideRow[]> {
    const { items, total } = sliceInMemory(await this.flags.listOverrides(key), page);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items;
  }

  @Post(":key/overrides")
  @HttpCode(201)
  setOverride(@Param("key") key: string, @Body() body: OverrideCreate): Promise<FeatureFlagOverrideRow> {
    return this.flags.setOverride(key, body);
  }

  @Delete("overrides/:overrideId")
  @HttpCode(204)
  deleteOverride(@Param("overrideId", UuidPipe) overrideId: string): Promise<void> {
    return this.flags.deleteOverride(overrideId);
  }
}

/** Evaluation is a cheap org-scoped read any authenticated member can make. */
@Controller("v1/feature-flags")
@UseGuards(TenantGuard)
export class FeatureFlagCheckController {
  constructor(
    private readonly flags: FlagsService,
    private readonly context: RequestContext,
  ) {}

  @Get("check/:key")
  async check(@Param("key") key: string): Promise<{ key: string; enabled: boolean }> {
    const tenant = this.context.requireTenant();
    const user = this.context.requireUser();
    return { key, enabled: await this.flags.isEnabled(tenant.organizationId, user.userId, key) };
  }
}
