import { SetMetadata } from "@nestjs/common";

export const REQUIRE_PERMISSION = "synapse:require_permission";

/** `@RequirePermission("member:invite")` — enforced by `PermissionsGuard` after tenant resolution. */
export const RequirePermission = (permission: string): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION, permission);
