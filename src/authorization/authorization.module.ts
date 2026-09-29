import { Module } from "@nestjs/common";
import { AuthorizationService } from "./authorization.service";
import { FgaSyncService } from "./fga/sync";
import { PermissionsGuard } from "./permissions.guard";
import { RolesRepository } from "./roles.repository";
import { SystemSeeder } from "./system-seed";

/**
 * The authorization engine: catalog, roles persistence, permission checks,
 * the OpenFGA tuple sync and the seed. The route family lives in `RolesModule`.
 */
@Module({
  providers: [RolesRepository, AuthorizationService, FgaSyncService, PermissionsGuard, SystemSeeder],
  exports: [RolesRepository, AuthorizationService, FgaSyncService, PermissionsGuard, SystemSeeder],
})
export class AuthorizationModule {}
