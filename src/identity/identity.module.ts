import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { UsageModule } from "../usage/usage.module";
import { SETTINGS } from "../core/config";
import { AuthGuard } from "./auth.guard";
import { IdentityController } from "./identity.controller";
import { IdentityService } from "./identity.service";
import { createIdentityProvider, IDENTITY_PROVIDER } from "./oidc/identity-provider";
import { OidcController } from "./oidc/oidc.controller";
import { PlatformAdminBootstrap } from "./platform-admin.bootstrap";
import { TokensRepository } from "./tokens.repository";
import { UsersRepository } from "./users.repository";

@Module({
  imports: [TenancyModule, ApiKeysModule, UsageModule],
  controllers: [IdentityController, OidcController],
  providers: [
    UsersRepository,
    TokensRepository,
    IdentityService,
    PlatformAdminBootstrap,
    { provide: IDENTITY_PROVIDER, inject: [SETTINGS], useFactory: createIdentityProvider },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [UsersRepository, IdentityService, PlatformAdminBootstrap, IDENTITY_PROVIDER],
})
export class IdentityModule {}
