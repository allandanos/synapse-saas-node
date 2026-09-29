import { Controller, Get, UseGuards } from "@nestjs/common";
import { PermissionsGuard } from "../../authorization/permissions.guard";
import { RequirePermission } from "../../authorization/require-permission.decorator";
import { Database } from "../../core/db/database";
import { RequestContext } from "../../core/request-context";
import { PlatformAdminGuard } from "../../tenancy/platform-admin.guard";
import { TenantGuard } from "../../tenancy/tenant.guard";
import { type MonthlyRevenue, type MonthlySpend, ReportingService, type RevenueSummary, type SpendSummary } from "./reporting.service";

/** The tenant's own spend position. */
@Controller("v1/billing")
@UseGuards(TenantGuard, PermissionsGuard)
@RequirePermission("billing:read")
export class SpendReportingController {
  constructor(
    private readonly db: Database,
    private readonly reporting: ReportingService,
    private readonly context: RequestContext,
  ) {}

  @Get("spend-summary")
  spendSummary(): Promise<SpendSummary> {
    const organizationId = this.context.requireTenant().organizationId;
    return this.db.transaction((tx) => this.reporting.orgSpendSummary(tx, organizationId));
  }

  @Get("spend-monthly")
  spendMonthly(): Promise<MonthlySpend[]> {
    const organizationId = this.context.requireTenant().organizationId;
    return this.db.transaction((tx) => this.reporting.orgMonthlySpend(tx, organizationId));
  }
}

/** Platform-wide revenue (ADR 0008: invisible to tenants — 404, not 403). */
@Controller("v1/billing/admin")
@UseGuards(PlatformAdminGuard)
export class RevenueReportingController {
  constructor(
    private readonly db: Database,
    private readonly reporting: ReportingService,
  ) {}

  @Get("revenue-summary")
  revenueSummary(): Promise<RevenueSummary> {
    return this.db.transaction((tx) => this.reporting.revenueSummary(tx));
  }

  @Get("revenue-monthly")
  revenueMonthly(): Promise<MonthlyRevenue[]> {
    return this.db.transaction((tx) => this.reporting.monthlyRevenue(tx));
  }
}
