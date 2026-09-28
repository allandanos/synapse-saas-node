import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { UsageModule } from "../usage/usage.module";
import { MembershipsController } from "./memberships.controller";
import { MembershipsRepository } from "./memberships.repository";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsRepository } from "./organizations.repository";
import { PlatformAdminGuard } from "./platform-admin.guard";
import { TenancyService } from "./tenancy.service";
import { TenantGuard } from "./tenant.guard";

@Module({
  imports: [AuthorizationModule, SubscriptionsModule, EntitlementsModule, UsageModule],
  controllers: [OrganizationsController, MembershipsController],
  providers: [OrganizationsRepository, MembershipsRepository, TenancyService, TenantGuard, PlatformAdminGuard],
  exports: [OrganizationsRepository, MembershipsRepository, TenancyService, TenantGuard, PlatformAdminGuard],
})
export class TenancyModule {}
