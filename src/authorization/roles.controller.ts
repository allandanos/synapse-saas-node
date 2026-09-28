import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import { Public } from "../identity/public.decorator";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { TenantGuard } from "../tenancy/tenant.guard";
import { RoleCreate, RoleUpdate } from "./authorization.dto";
import { AuthorizationService, type RoleRead } from "./authorization.service";
import { type PermissionDef, PERMISSIONS } from "./permissions";
import { RequirePermission } from "./require-permission.decorator";

@Controller("v1")
export class RolesController {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly context: RequestContext,
  ) {}

  /** The catalog is public data — the reference serves it without a credential. */
  @Public()
  @Get("permissions")
  listPermissions(): PermissionDef[] {
    return PERMISSIONS.map((p) => ({ key: p.key, resource: p.resource, action: p.action, description: p.description }));
  }

  @Get("roles")
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("member:read")
  list(): Promise<RoleRead[]> {
    return this.authorization.listRoles(this.context.requireTenant().organizationId);
  }

  @Post("roles")
  @HttpCode(201)
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("role:manage")
  create(@Body() body: RoleCreate): Promise<RoleRead> {
    return this.authorization.createCustomRole({
      organizationId: this.context.requireTenant().organizationId,
      key: body.key,
      name: body.name,
      description: body.description ?? null,
      permissions: body.permissions,
    });
  }

  @Patch("roles/:roleId")
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("role:manage")
  update(@Param("roleId", UuidPipe) roleId: string, @Body() body: RoleUpdate): Promise<RoleRead> {
    return this.authorization.updateCustomRole(roleId, this.context.requireTenant().organizationId, {
      name: body.name ?? undefined,
      description: body.description,
      permissions: body.permissions ?? undefined,
    });
  }

  @Delete("roles/:roleId")
  @HttpCode(204)
  @UseGuards(TenantGuard, PermissionsGuard)
  @RequirePermission("role:manage")
  remove(@Param("roleId", UuidPipe) roleId: string): Promise<void> {
    return this.authorization.deleteCustomRole(roleId, this.context.requireTenant().organizationId);
  }
}
