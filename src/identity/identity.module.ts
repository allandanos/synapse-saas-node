import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AuthGuard } from "./auth.guard";
import { IdentityController } from "./identity.controller";
import { IdentityService } from "./identity.service";
import { PlatformAdminBootstrap } from "./platform-admin.bootstrap";
import { TokensRepository } from "./tokens.repository";
import { UsersRepository } from "./users.repository";

@Module({
  imports: [TenancyModule, ApiKeysModule],
  controllers: [IdentityController],
  providers: [UsersRepository, TokensRepository, IdentityService, PlatformAdminBootstrap, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [UsersRepository, IdentityService, PlatformAdminBootstrap],
})
export class IdentityModule {}
