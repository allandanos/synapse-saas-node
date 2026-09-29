import { Injectable, Logger } from "@nestjs/common";
import { Database, type Tx } from "../../core/db/database";
import { DomainError } from "../../core/errors";
import { events } from "../../core/events";
import { OutboxWriter } from "../../core/outbox";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { SubscriptionsRepository } from "../../subscriptions/subscriptions.repository";
import { SubscriptionsService } from "../../subscriptions/subscriptions.service";
import { BillingCustomersRepository } from "../billing-customers.repository";
import { BillingService } from "../billing.service";
import { InvoicesRepository } from "../invoicing/invoices.repository";
import { BillingEventType, type BillingProvider, type NormalizedBillingEvent, type WebhookRequest } from "../providers";
import { BillingProviderRegistry } from "../registry";
import { WebhookLedgerRepository } from "./ledger.repository";

export interface WebhookOutcome {
  status: "processed" | "duplicate" | "unprocessable";
  events_applied: number;
  events_rejected?: number;
}

/**
 * Billing webhook ingest.
 *
 * Per request: verify the signature over the RAW bytes → claim the ledger row
 * (a duplicate is a 200 no-op) → translate → apply each event.
 *
 * Failure semantics: a business rejection (`DomainError` — e.g. an illegal
 * state transition from a late event) is recorded on the ledger row and the
 * request still answers 200, because retrying cannot change the outcome.
 * Anything else propagates: the ledger row rolls back with the transaction and
 * the provider's retry re-processes the event, so a transient database error
 * can never permanently lose `invoice.paid` or `subscription.canceled`.
 */
@Injectable()
export class BillingWebhooksService {
  private readonly logger = new Logger(BillingWebhooksService.name);

  constructor(
    private readonly db: Database,
    private readonly registry: BillingProviderRegistry,
    private readonly ledger: WebhookLedgerRepository,
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionsService,
    private readonly subscriptionRows: SubscriptionsRepository,
    private readonly customers: BillingCustomersRepository,
    private readonly invoices: InvoicesRepository,
    private readonly entitlements: EntitlementsService,
    private readonly outbox: OutboxWriter,
  ) {}

  async handle(providerName: string, raw: WebhookRequest, override?: BillingProvider): Promise<WebhookOutcome> {
    const provider = override ?? this.registry.build(providerName);
    const verified = await provider.verifyWebhook(raw);

    return this.db.transaction(async (tx) => {
      const ledgerId = await this.ledger.claim(tx, providerName, verified.providerEventId, verified.eventType);
      if (ledgerId === undefined) {
        this.logger.log(`webhook duplicate ignored provider=${providerName} event=${verified.providerEventId}`);
        return { status: "duplicate", events_applied: 0 };
      }

      // A payload we cannot translate will not translate on retry either:
      // record it on the ledger row and answer 200 so the provider stops.
      let normalized: NormalizedBillingEvent[];
      try {
        normalized = provider.translateWebhook(verified);
      } catch (error) {
        this.logger.warn(`webhook translate failed provider=${providerName}: ${message(error)}`);
        await this.ledger.markProcessed(tx, ledgerId, `translate: ${message(error)}`);
        return { status: "unprocessable", events_applied: 0, events_rejected: 1 };
      }

      let applied = 0;
      const rejected: string[] = [];
      for (const event of normalized) {
        // A savepoint per event: one business rejection must not roll the batch back.
        await tx.query("SAVEPOINT webhook_event");
        try {
          await this.apply(tx, providerName, event);
          await tx.query("RELEASE SAVEPOINT webhook_event");
          applied += 1;
        } catch (error) {
          if (!(error instanceof DomainError)) throw error; // infra: propagate, roll the ledger row back too
          await tx.query("ROLLBACK TO SAVEPOINT webhook_event");
          rejected.push(`${event.eventType}: ${message(error)}`);
          this.logger.log(`webhook event rejected provider=${providerName} type=${event.eventType}: ${message(error)}`);
        }
      }
      await this.ledger.markProcessed(tx, ledgerId, rejected.join("; ") || null);
      return { status: "processed", events_applied: applied, events_rejected: rejected.length };
    });
  }

  // ── Application ───────────────────────────────────────────────────────────

  private async apply(tx: Tx, providerName: string, event: NormalizedBillingEvent): Promise<void> {
    // Webhooks arrive unauthenticated: the org is known only through the
    // provider's ids. Resolve through the SECURITY DEFINER lookup so the query
    // is not empty under RLS, then bind the tenant for the writes that follow.
    const organizationId = await this.organizationFor(tx, event);
    if (organizationId === null) {
      this.logger.debug(`webhook event has no organization type=${event.eventType}`);
      return;
    }
    await tx.bindTenant(organizationId);

    switch (event.eventType) {
      case BillingEventType.SUBSCRIPTION_ACTIVATED:
      case BillingEventType.SUBSCRIPTION_CREATED:
      case BillingEventType.SUBSCRIPTION_TRIAL_ENDED:
        return this.applyStatus(tx, organizationId, event, "active");
      case BillingEventType.SUBSCRIPTION_UPDATED:
        return this.applyStatus(tx, organizationId, event, event.status ?? "active");
      case BillingEventType.SUBSCRIPTION_CANCELED:
        return this.applyStatus(tx, organizationId, event, "canceled");
      case BillingEventType.SUBSCRIPTION_PAST_DUE:
        return this.applyStatus(tx, organizationId, event, "past_due");
      case BillingEventType.INVOICE_PAID:
        return this.upsertInvoice(tx, providerName, organizationId, event, "paid");
      case BillingEventType.INVOICE_CREATED:
        return this.upsertInvoice(tx, providerName, organizationId, event, "open");
      case BillingEventType.INVOICE_FAILED:
        return this.upsertInvoice(tx, providerName, organizationId, event, "uncollectible");
      case BillingEventType.CHECKOUT_COMPLETED:
        return this.applyCheckoutCompleted(tx, organizationId, event);
      default:
        this.logger.debug(`webhook event ignored type=${event.eventType}`);
        return;
    }
  }

  private async organizationFor(tx: Tx, event: NormalizedBillingEvent): Promise<string | null> {
    const row = await tx.one<{ organization_id: string | null }>(`SELECT synapse_org_for_provider_ref($1, $2) AS organization_id`, [
      event.providerCustomerId ?? null,
      event.providerSubscriptionId ?? null,
    ]);
    return row?.organization_id ?? null;
  }

  private async applyStatus(tx: Tx, organizationId: string, event: NormalizedBillingEvent, targetStatus: string): Promise<void> {
    const subscription = await this.subscriptionRows.currentForOrganization(tx, organizationId);
    if (!subscription) {
      this.logger.debug(`webhook status change has no subscription org=${organizationId}`);
      return;
    }
    await this.subscriptions.applyProviderTransition(tx, subscription, targetStatus, event.currentPeriodEnd ?? undefined);
    await this.entitlements.invalidate(tx, organizationId);
    await this.outbox.append(tx, {
      eventType: events.SUBSCRIPTION_UPDATED,
      aggregateType: "subscription",
      aggregateId: subscription.id,
      organizationId,
      payload: { status: targetStatus, provider_event: event.eventType },
    });
  }

  private async applyCheckoutCompleted(tx: Tx, organizationId: string, event: NormalizedBillingEvent): Promise<void> {
    if (!event.planKey) {
      this.logger.debug(`checkout.completed without a plan_key org=${organizationId}`);
      return;
    }
    const organization = await this.billing.requireOrganization(tx, organizationId);
    const plan = await this.subscriptions.planByKey(tx, event.planKey);
    await this.billing.completeCheckout(tx, organization, plan, { providerSubscriptionId: event.providerSubscriptionId ?? null, source: "webhook" });
  }

  private async upsertInvoice(
    tx: Tx,
    providerName: string,
    organizationId: string,
    event: NormalizedBillingEvent,
    status: "paid" | "open" | "uncollectible",
  ): Promise<void> {
    if (!event.providerInvoiceId) return;
    const customer = await this.customers.findByOrganization(tx, organizationId);
    const existing = await this.invoices.findByProviderRef(tx, providerName, event.providerInvoiceId);
    const total = event.amountCents ?? 0;
    const patch = {
      billing_customer_id: customer?.id ?? null,
      currency: event.currency ?? "PHP",
      total_cents: total,
      status,
      hosted_url: event.hostedUrl ?? null,
      paid_at: status === "paid" ? event.occurredAt : null,
    };
    const invoice = existing
      ? await this.invoices.update(tx, existing.id, patch)
      : await this.invoices.insert(tx, {
          organizationId,
          billingCustomerId: customer?.id ?? null,
          provider: providerName,
          providerInvoiceId: event.providerInvoiceId,
          currency: patch.currency,
          subtotalCents: 0,
          totalCents: total,
          status,
          periodStart: null,
          periodEnd: null,
          hostedUrl: patch.hosted_url,
          paidAt: patch.paid_at,
        });

    if (status === "paid") {
      await this.outbox.append(tx, {
        eventType: events.INVOICE_PAID,
        aggregateType: "invoice",
        aggregateId: invoice.id,
        organizationId,
        payload: { total_cents: invoice.total_cents, currency: invoice.currency },
      });
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
