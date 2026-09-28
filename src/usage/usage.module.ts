import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { UsageRepository } from "./usage.repository";
import { UsageService } from "./usage.service";

/** The metering engine. Routes live in `UsageRoutesModule`. */
@Module({
  imports: [SubscriptionsModule, EntitlementsModule],
  providers: [UsageRepository, UsageService],
  exports: [UsageRepository, UsageService],
})
export class UsageModule {}
