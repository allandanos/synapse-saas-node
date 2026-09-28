import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthorizationService } from "./authorization.service";
import { REQUIRE_PERMISSION } from "./require-permission.decorator";

/** Runs after `TenantGuard`: checks the route's `@RequirePermission()` for the bound principal + tenant. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION, [context.getHandler(), context.getClass()]);
    if (!permission) return true;
    await this.authorization.requirePermission(permission);
    return true;
  }
}
