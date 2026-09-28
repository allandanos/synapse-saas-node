import { Body, Controller, Get, HttpCode, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { BillingService } from "../billing/billing.service";
import { Database } from "../core/db/database";
import { PageQuery, TOTAL_COUNT_HEADER } from "../core/pagination";
import { RequestContext } from "../core/request-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { EffectiveEntitlementsRead } from "../entitlements/resolver";
import { TenantGuard } from "../tenancy/tenant.guard";
import { UsageService } from "../usage/usage.service";
import { type PlanRead, PlansRepository, toPlanRead } from "./plans.repository";
import { CancelRequest, PlanChangeRequest, TrialStartRequest } from "./subscriptions.dto";
import { type SubscriptionRead, SubscriptionsService, toSubscriptionRead } from "./subscriptions.service";

export interface CurrentSubscriptionRead {
  subscription: SubscriptionRead | null;
  entitlements: EffectiveEntitlementsRead;
  usage: { metric: string; used: number }[];
}

/** `/v1/plans` (any authenticated user) and `/v1/subscription*` (tenant, billing permissions). */
@Controller("v1")
export class SubscriptionsController {
  constructor(
    private readonly db: Database,
    private readonly context: RequestContext,
    private readonly plans: PlansRepository,
    private readonly subscriptions: SubscriptionsService,
    private readonly entitlements: EntitlementsService,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
  ) {}

  /** Public plans as a plain array + `X-Total-Count`. */
  @Get("plans")
  async listPlans(@Query() page: PageQuery, @Res({ passthrough: true }) res: Response): Promise<PlanRead[]> {
    const { plans, total } = await this.db.transaction((tx) => this.plans.listPublic(tx, page.limit, page.offset));
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return plans.map(toPlanRead);
  }

  @Get("subscription")
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("billing:read")
  current(): Promise<CurrentSubscriptionRead> {
    const organizationId = this.context.requireTenant().organizationId;
    return this.db.transaction(async (tx) => {
      const current = await this.subscriptions.currentForOrganization(tx, organizationId);
      const effective = await this.entitlements.effectiveForOrg(tx, organizationId);
      const usage = await this.usage.summary(tx, organizationId);
      return { subscription: current ? toSubscriptionRead(current) : null, entitlements: effective.toRead(), usage };
    });
  }

  @Post("subscription/trial")
  @HttpCode(201)
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("billing:manage")
  async startTrial(@Body() body: TrialStartRequest): Promise<SubscriptionRead> {
    const organizationId = this.context.requireTenant().organizationId;
    return toSubscriptionRead(await this.db.transaction((tx) => this.subscriptions.startTrial(tx, organizationId, body.plan_key)));
  }

  /** Through the billing service: a hosted provider must be told, a local provider prorates (ADR 0004). */
  @Post("subscription/change")
  @HttpCode(200)
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("billing:manage")
  async changePlan(@Body() body: PlanChangeRequest): Promise<SubscriptionRead> {
    return toSubscriptionRead(await this.billing.changePlan(this.context.requireTenant().organizationId, body.plan_key));
  }

  @Post("subscription/cancel")
  @HttpCode(200)
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("billing:manage")
  async cancel(@Body() body: CancelRequest): Promise<SubscriptionRead> {
    const organizationId = this.context.requireTenant().organizationId;
    return toSubscriptionRead(await this.db.transaction((tx) => this.subscriptions.cancel(tx, organizationId, body.at_period_end ?? true)));
  }

  @Post("subscription/resume")
  @HttpCode(200)
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("billing:manage")
  async resume(): Promise<SubscriptionRead> {
    const organizationId = this.context.requireTenant().organizationId;
    return toSubscriptionRead(await this.db.transaction((tx) => this.subscriptions.resume(tx, organizationId)));
  }
}
