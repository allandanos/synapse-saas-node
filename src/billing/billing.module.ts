import { Module } from "@nestjs/common";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { BillingService } from "./billing.service";

/** Plan changes through the provider capability table; the rest of billing arrives with milestone 4. */
@Module({
  imports: [SubscriptionsModule],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
