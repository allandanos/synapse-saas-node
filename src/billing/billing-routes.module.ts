import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { BillingController } from "./billing.controller";
import { BillingModule } from "./billing.module";
import { AdminInvoicesController, InvoicesController } from "./invoicing/invoices.controller";
import { RevenueReportingController, SpendReportingController } from "./reporting/reporting.controller";
import { BillingWebhooksController } from "./webhooks/billing-webhooks.controller";

/** `/v1/billing/*`: checkout, portal, invoices, spend + revenue reports, provider webhooks. */
@Module({
  imports: [BillingModule, SubscriptionsModule, TenancyModule, AuthorizationModule],
  controllers: [BillingController, InvoicesController, AdminInvoicesController, SpendReportingController, RevenueReportingController, BillingWebhooksController],
})
export class BillingRoutesModule {}
