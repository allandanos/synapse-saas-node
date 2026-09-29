import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { PageQuery, sliceInMemory, TOTAL_COUNT_HEADER } from "../core/pagination";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import { FeatureGuard, RequireFeature } from "../entitlements/feature.guard";
import { TenantGuard } from "../tenancy/tenant.guard";
import { AgentCreate, AgentUpdate } from "./agents.dto";
import type { AgentRead } from "./agents.repository";
import { AgentsService } from "./agents.service";

/**
 * Agent registry endpoints (ADR 0007): governance and billing, no execution.
 *
 * The whole router sits behind the `agents` entitlement — one declaration, not
 * one call per handler — so a plan without it answers 403 `feature_not_entitled`
 * with `available_in[]` + `upgrade_url` before any permission is considered,
 * exactly like the reference's router-level `Depends(require_feature("agents"))`.
 */
@Controller("v1/agents")
@UseGuards(TenantGuard, FeatureGuard, PermissionsGuard)
@RequireFeature("agents")
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly context: RequestContext,
  ) {}

  @Get()
  @RequirePermission("agents:read")
  async list(@Query() page: PageQuery, @Res({ passthrough: true }) res: Response): Promise<AgentRead[]> {
    const rows = await this.agents.list(this.context.requireTenant().organizationId);
    const { items, total } = sliceInMemory(rows, page);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items;
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("agents:manage")
  create(@Body() body: AgentCreate): Promise<AgentRead> {
    return this.agents.create(this.context.requireTenant().organizationId, {
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      config: body.config ?? {},
    });
  }

  @Get(":agentId")
  @RequirePermission("agents:read")
  get(@Param("agentId", UuidPipe) agentId: string): Promise<AgentRead> {
    return this.agents.get(this.context.requireTenant().organizationId, agentId);
  }

  @Patch(":agentId")
  @RequirePermission("agents:manage")
  update(@Param("agentId", UuidPipe) agentId: string, @Body() body: AgentUpdate): Promise<AgentRead> {
    return this.agents.update(this.context.requireTenant().organizationId, agentId, body);
  }

  @Post(":agentId/disable")
  @HttpCode(200)
  @RequirePermission("agents:manage")
  disable(@Param("agentId", UuidPipe) agentId: string): Promise<AgentRead> {
    return this.agents.setStatus(this.context.requireTenant().organizationId, agentId, "disabled");
  }

  @Post(":agentId/enable")
  @HttpCode(200)
  @RequirePermission("agents:manage")
  enable(@Param("agentId", UuidPipe) agentId: string): Promise<AgentRead> {
    return this.agents.setStatus(this.context.requireTenant().organizationId, agentId, "active");
  }

  @Delete(":agentId")
  @HttpCode(204)
  @RequirePermission("agents:manage")
  remove(@Param("agentId", UuidPipe) agentId: string): Promise<void> {
    return this.agents.delete(this.context.requireTenant().organizationId, agentId);
  }
}
