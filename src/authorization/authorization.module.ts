import { Module } from "@nestjs/common";
import { AuthorizationService } from "./authorization.service";
import { PermissionsGuard } from "./permissions.guard";
import { RolesRepository } from "./roles.repository";
import { SystemSeeder } from "./system-seed";

/** The RBAC engine: catalog, roles persistence, permission checks, seed. Route family lives in `RolesModule`. */
@Module({
  providers: [RolesRepository, AuthorizationService, PermissionsGuard, SystemSeeder],
  exports: [RolesRepository, AuthorizationService, PermissionsGuard, SystemSeeder],
})
export class AuthorizationModule {}
