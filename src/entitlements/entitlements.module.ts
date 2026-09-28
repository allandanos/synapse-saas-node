import { Module } from "@nestjs/common";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { EntitlementsRepository } from "./entitlements.repository";
import { EntitlementsService } from "./entitlements.service";
import { FeatureGuard } from "./feature.guard";

/** The entitlement engine (resolver + grants). Routes live in `EntitlementsRoutesModule`. */
@Module({
  imports: [SubscriptionsModule],
  providers: [EntitlementsRepository, EntitlementsService, FeatureGuard],
  exports: [EntitlementsRepository, EntitlementsService, FeatureGuard],
})
export class EntitlementsModule {}
