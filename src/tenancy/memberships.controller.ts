import { Body, Controller, Delete, HttpCode, Param, Patch, UseGuards } from "@nestjs/common";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import type { MembershipRead } from "./memberships.repository";
import { TenancyService } from "./tenancy.service";
import { MemberUpdate } from "./tenancy.dto";
import { TenantGuard } from "./tenant.guard";

@Controller("v1/memberships")
@UseGuards(TenantGuard, PermissionsGuard)
export class MembershipsController {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly context: RequestContext,
  ) {}

  @Patch(":membershipId")
  @RequirePermission("member:update")
  update(@Param("membershipId", UuidPipe) membershipId: string, @Body() body: MemberUpdate): Promise<MembershipRead> {
    return this.tenancy.updateMembership(membershipId, this.context.requireTenant().organizationId, {
      roleKeys: body.role_keys,
      status: body.status,
    });
  }

  @Delete(":membershipId")
  @HttpCode(204)
  @RequirePermission("member:remove")
  remove(@Param("membershipId", UuidPipe) membershipId: string): Promise<void> {
    return this.tenancy.removeMember(membershipId, this.context.requireTenant().organizationId);
  }
}
