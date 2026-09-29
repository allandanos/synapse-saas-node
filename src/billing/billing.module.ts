import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { UsageModule } from "../usage/usage.module";
import { BillingCustomersRepository } from "./billing-customers.repository";
import { BillingService } from "./billing.service";
import { PlanCatalogPush } from "./plan-catalog-push";
import { InvoicesRepository } from "./invoicing/invoices.repository";
import { InvoicingService } from "./invoicing/invoicing.service";
import { BillingProviderRegistry } from "./registry";
import { ReportingService } from "./reporting/reporting.service";
import { BillingWebhooksService } from "./webhooks/billing-webhooks.service";
import { WebhookLedgerRepository } from "./webhooks/ledger.repository";

const ENGINE = [
  BillingProviderRegistry,
  BillingCustomersRepository,
  InvoicesRepository,
  InvoicingService,
  ReportingService,
  WebhookLedgerRepository,
  BillingWebhooksService,
  BillingService,
  PlanCatalogPush,
];

/**
 * The billing engine: providers, customers, checkout, invoicing, reporting and
 * webhook ingest. Routes live in `BillingRoutesModule`; the worker drives the
 * same services for renewals.
 */
@Module({
  imports: [SubscriptionsModule, EntitlementsModule, UsageModule, TenancyModule],
  providers: ENGINE,
  exports: ENGINE,
})
export class BillingModule {}
