import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { BillingModule } from "../billing/billing.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { UsageModule } from "../usage/usage.module";
import { SubscriptionsController } from "./subscriptions.controller";
import { SubscriptionsModule } from "./subscriptions.module";

/** The `/v1/plans` + `/v1/subscription*` route family (needs the tenant guard, hence separate from the engine). */
@Module({
  imports: [SubscriptionsModule, EntitlementsModule, UsageModule, BillingModule, TenancyModule, AuthorizationModule],
  controllers: [SubscriptionsController],
})
export class SubscriptionsRoutesModule {}
