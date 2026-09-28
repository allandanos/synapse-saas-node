import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { type Page, PageQuery } from "../core/pagination";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import type { MembershipRead } from "./memberships.repository";
import type { OrganizationRead } from "./organizations.repository";
import { PlatformAdminGuard } from "./platform-admin.guard";
import { TenancyService } from "./tenancy.service";
import { MemberInvite, OrganizationCreate, OrganizationUpdate } from "./tenancy.dto";
import { TenantGuard } from "./tenant.guard";

@Controller("v1/orgs")
export class OrganizationsController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly context: RequestContext,
  ) {}

  @Get()
  listMyOrgs(): Promise<Page<OrganizationRead>> {
    return this.tenancy.listMyOrganizations(this.context.requireUser().userId);
  }

  @Post()
  @HttpCode(201)
  create(@Body() body: OrganizationCreate): Promise<OrganizationRead> {
    return this.tenancy.createOrganization({ name: body.name, slug: body.slug, ownerUserId: this.context.requireUser().userId });
  }

  @Get("current")
  @UseGuards(TenantGuard)
  current(): Promise<OrganizationRead> {
    return this.tenancy.getOrganization(this.context.requireTenant().organizationId);
  }

  @Patch("current")
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("org:update")
  updateCurrent(@Body() body: OrganizationUpdate): Promise<OrganizationRead> {
    return this.tenancy.updateOrganization(this.context.requireTenant().organizationId, { name: body.name, settings: body.settings });
  }

  // ── Members ──────────────────────────────────────────────────────────────────

  @Get("current/members")
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("member:read")
  listMembers(@Query() page: PageQuery): Promise<Page<MembershipRead>> {
    return this.tenancy.listMembers(this.context.requireTenant().organizationId, page);
  }

  @Post("current/members/invite")
  @HttpCode(201)
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("member:invite")
  async invite(@Body() body: MemberInvite): Promise<MembershipRead> {
    const tenant = this.context.requireTenant();
    const org = await this.tenancy.getOrganization(tenant.organizationId);
    return this.tenancy.inviteMember({ organizationId: tenant.organizationId, email: body.email, roleKeys: body.role_keys, organizationName: org.name });
  }

  // ── Platform admin (ADR 0008) ────────────────────────────────────────────────

  @Post(":orgId/suspend")
  @HttpCode(204)
  @UseGuards(PlatformAdminGuard)
  suspend(@Param("orgId", UuidPipe) orgId: string): Promise<void> {
    return this.tenancy.suspendOrganization(orgId);
  }

  @Delete(":orgId/suspend")
  @HttpCode(204)
  @UseGuards(PlatformAdminGuard)
  unsuspend(@Param("orgId", UuidPipe) orgId: string): Promise<void> {
    return this.tenancy.unsuspendOrganization(orgId);
  }
}
