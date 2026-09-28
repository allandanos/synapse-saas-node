import { Module } from "@nestjs/common";
import { PlanCatalogSync } from "./catalog-sync";
import { PlansRepository } from "./plans.repository";
import { SubscriptionsRepository } from "./subscriptions.repository";
import { SubscriptionsService } from "./subscriptions.service";

/** The subscription engine: catalog projection, plans, subscription lifecycle. Routes live in `SubscriptionsRoutesModule`. */
@Module({
  providers: [PlansRepository, SubscriptionsRepository, SubscriptionsService, PlanCatalogSync],
  exports: [PlansRepository, SubscriptionsRepository, SubscriptionsService, PlanCatalogSync],
})
export class SubscriptionsModule {}
