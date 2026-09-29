import { Inject, Injectable, Logger } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import { CheckoutConfirmNotAllowedError, CheckoutRequiredError, OrganizationNotFoundError } from "../core/errors";
import { events } from "../core/events";
import { OutboxWriter } from "../core/outbox";
import { RequestContext } from "../core/request-context";
import type { PlanWithDetails } from "../subscriptions/plans.repository";
import { arrearsAdjustmentCents, prorate } from "../subscriptions/proration";
import { SubscriptionsRepository, type SubscriptionRow } from "../subscriptions/subscriptions.repository";
import { SubscriptionsService, type SubscriptionWithPlan } from "../subscriptions/subscriptions.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { OrganizationsRepository, type OrganizationRow } from "../tenancy/organizations.repository";
import { type BillingCustomerRow, BillingCustomersRepository } from "./billing-customers.repository";
import { InvoicesRepository } from "./invoicing/invoices.repository";
import { BillingCapability, type BillingProvider, capabilitiesOf, type CheckoutResult } from "./providers";
import { BillingProviderRegistry } from "./registry";

interface PeriodSnapshot {
  plan_key: string;
  price_cents: number;
  period_start: Date;
  period_end: Date;
}

/** What the org was paying, and for which period, before the change. */
export function periodSnapshot(subscription: SubscriptionRow | null | undefined): PeriodSnapshot | null {
  if (!subscription || subscription.status !== "active") return null;
  return {
    plan_key: String(subscription.plan_snapshot.key ?? ""),
    price_cents: Number(subscription.plan_snapshot.price_cents ?? 0),
    period_start: subscription.current_period_start,
    period_end: subscription.current_period_end,
  };
}

/** Prorate the switch if the period was kept; null when nothing is owed either way. */
export function prorationAdjustment(previous: PeriodSnapshot | null, subscription: SubscriptionRow, plan: PlanWithDetails, now = new Date()): Record<string, unknown> | null {
  if (!previous || subscription.current_period_end.getTime() !== previous.period_end.getTime()) return null; // period reset ⇒ bills in full
  const newPrice = plan.price_cents ?? 0;
  const amount = arrearsAdjustmentCents(previous.price_cents, newPrice, previous.period_start, previous.period_end, now);
  if (amount === 0) return null;
  const elapsed = prorate(previous.price_cents, newPrice, previous.period_start, previous.period_end, now).elapsedFraction;
  const what = amount < 0 ? "credit" : "charge";
  return {
    kind: "proration",
    amount_cents: amount,
    description: `Plan change ${previous.plan_key} → ${plan.key}: ${what} for ${(elapsed * 100).toFixed(1)}% of the period at the previous price`,
    from_plan: previous.plan_key,
    to_plan: plan.key,
    from_price_cents: previous.price_cents,
    to_price_cents: newPrice,
    created_at: now.toISOString(),
  };
}

export interface CheckoutStart {
  customer: BillingCustomerRow;
  result: CheckoutResult;
}

/**
 * The billing domain service: customers, checkout, the billing portal, and
 * plan changes through the active provider (ADR 0004). Provider calls happen
 * BEFORE the local mutation, so a failed provider call leaves no local state
 * behind.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly registry: BillingProviderRegistry,
    private readonly subscriptions: SubscriptionsService,
    private readonly subscriptionRows: SubscriptionsRepository,
    private readonly customers: BillingCustomersRepository,
    private readonly organizations: OrganizationsRepository,
    private readonly invoices: InvoicesRepository,
    private readonly entitlements: EntitlementsService,
    private readonly outbox: OutboxWriter,
    private readonly context: RequestContext,
  ) {}

  get providerName(): string {
    return this.settings.SYNAPSE_BILLING_PROVIDER;
  }

  /** The configured provider client. Built per call so credentials are read fresh. */
  provider(): BillingProvider {
    return this.registry.current();
  }

  // ── Customers ───────────────────────────────────────────────────────────────

  /** The org's `billing_customers` row, creating the provider-side customer on first use. */
  async ensureCustomer(tx: Tx, organization: OrganizationRow, contact?: { email: string; name: string | null } | null): Promise<BillingCustomerRow> {
    const existing = await this.customers.findByOrganization(tx, organization.id);
    if (existing) return existing;
    const owner = contact ?? (await this.ownerContact(tx, organization));
    const provider = this.provider();
    const ref = await provider.createCustomer({
      email: owner.email,
      name: owner.name,
      organizationId: organization.id,
      currency: this.settings.SYNAPSE_BILLING_CURRENCY,
    });
    return this.customers.insert(tx, {
      organizationId: organization.id,
      provider: provider.name,
      providerCustomerId: ref.providerCustomerId,
      email: ref.email ?? null,
      name: ref.name ?? null,
      currency: this.settings.SYNAPSE_BILLING_CURRENCY,
    });
  }

  private async ownerContact(tx: Tx, organization: OrganizationRow): Promise<{ email: string; name: string | null }> {
    const owner = await this.customers.ownerContact(tx, organization.id);
    if (owner) return { email: owner.email, name: owner.display_name };
    return { email: `${organization.slug}@example.com`, name: organization.name };
  }

  // ── Checkout ────────────────────────────────────────────────────────────────

  /** Create a checkout with the provider and return its URL (or the manual instructions). */
  async startCheckout(
    tx: Tx,
    organization: OrganizationRow,
    plan: PlanWithDetails,
    urls: { successUrl?: string; cancelUrl?: string } = {},
    contact?: { email: string; name: string | null } | null,
  ): Promise<CheckoutStart> {
    const customer = await this.ensureCustomer(tx, organization, contact);
    const result = await this.provider().createCheckout({
      planKey: plan.key,
      planName: plan.name,
      priceCents: plan.price_cents ?? 0,
      currency: plan.currency,
      interval: plan.interval ?? "month",
      providerCustomerId: customer.provider_customer_id,
      successUrl: urls.successUrl ?? null,
      cancelUrl: urls.cancelUrl ?? null,
      organizationId: organization.id,
    });
    return { customer, result };
  }

  /**
   * Activate the subscription after checkout.
   *
   * `source: "webhook"` is the provider telling us payment happened;
   * `source: "client_confirm"` is the tenant telling us — only trustworthy on a
   * provider with no payment truth of its own (CLIENT_CONFIRM), otherwise
   * confirming would be a free upgrade.
   */
  async completeCheckout(
    tx: Tx,
    organization: OrganizationRow,
    plan: PlanWithDetails,
    options: { providerSubscriptionId?: string | null; contact?: { email: string; name: string | null } | null; source: "webhook" | "client_confirm" },
  ): Promise<SubscriptionWithPlan> {
    const provider = this.provider();
    if (options.source === "client_confirm" && !provider.supports.has(BillingCapability.CLIENT_CONFIRM)) {
      throw new CheckoutConfirmNotAllowedError(
        `${provider.name} verifies payment via its own callback; activation happens when the provider webhook arrives, not on client confirmation`,
        { provider: provider.name },
      );
    }
    const customer = await this.ensureCustomer(tx, organization, options.contact);
    const subscription = await this.subscriptions.changePlan(tx, organization.id, {
      planKey: plan.key,
      provider: provider.name,
      providerSubscriptionId: options.providerSubscriptionId ?? null,
    });
    await this.recordInvoice(tx, customer, plan, provider.name);
    return subscription;
  }

  /** The provider's self-service portal, or null when it has none (or no customer yet). */
  async billingPortalUrl(tx: Tx, organization: OrganizationRow, returnUrl: string): Promise<string | null> {
    const provider = this.provider();
    if (!provider.supports.has(BillingCapability.BILLING_PORTAL)) return null;
    const customer = await this.ensureCustomer(tx, organization);
    if (customer.provider_customer_id === null) return null;
    return provider.billingPortalUrl(customer.provider_customer_id, returnUrl);
  }

  /** The plan charge booked at activation time; free plans bill nothing. */
  private async recordInvoice(tx: Tx, customer: BillingCustomerRow, plan: PlanWithDetails, providerName: string): Promise<void> {
    const price = plan.price_cents ?? 0;
    if (price <= 0) return;
    const invoice = await this.invoices.insert(tx, {
      organizationId: customer.organization_id,
      billingCustomerId: customer.id,
      provider: providerName,
      currency: plan.currency,
      subtotalCents: price,
      totalCents: price,
      status: "open",
      periodStart: null,
      periodEnd: null,
    });
    await this.outbox.append(tx, {
      eventType: events.INVOICE_CREATED,
      aggregateType: "invoice",
      aggregateId: invoice.id,
      organizationId: customer.organization_id,
      payload: { total_cents: price, currency: plan.currency, plan_key: plan.key },
    });
  }

  /** `{web_origin}/dashboard/billing…` — the checkout return and portal URLs. */
  webUrl(path: string): string {
    return `${this.settings.SYNAPSE_WEB_ORIGIN.replace(/\/+$/, "")}${path}`;
  }

  /** The org row, or 404 — every billing route is scoped to one organization. */
  async requireOrganization(tx: Tx, organizationId: string): Promise<OrganizationRow> {
    const organization = await this.organizations.findById(tx, organizationId);
    if (!organization) throw new OrganizationNotFoundError("Organization not found");
    return organization;
  }

  /** The acting user as a billing contact, when a user is acting at all. */
  actingContact(): { email: string; name: string | null } | null {
    const user = this.context.user();
    return user ? { email: user.email, name: null } : null;
  }

  changePlan(organizationId: string, planKey: string): Promise<SubscriptionWithPlan> {
    return this.db.transaction((tx) => this.changePlanIn(tx, organizationId, planKey));
  }

  /**
   * - provider bills recurring (Stripe/…): the subscription must have been
   *   purchased through it (`provider_subscription_id`), else 409
   *   `checkout_required`; the provider owns proration and invoicing.
   * - otherwise (manual/Xendit/PayMongo/Paddle): apply locally. paid→paid keeps
   *   the period and queues the prorated correction for that period's invoice
   *   (billed in arrears); free→paid starts a fresh cycle today.
   */
  async changePlanIn(tx: Tx, organizationId: string, planKey: string): Promise<SubscriptionWithPlan> {
    const plan = await this.subscriptions.planByKey(tx, planKey);
    const current = await this.subscriptionRows.currentForOrganization(tx, organizationId);

    if (capabilitiesOf(this.providerName).has(BillingCapability.RECURRING_HOSTED)) {
      if (!current || !current.provider_subscription_id) {
        throw new CheckoutRequiredError(`Plan changes on ${this.providerName} require a subscription purchased through it`, {
          plan_key: planKey,
          checkout_url: "/v1/billing/checkout",
        });
      }
      const changed = await this.changePlanWithProvider(tx, organizationId, current, plan);
      await this.entitlements.invalidate(tx, organizationId);
      return changed;
    }

    const previous = periodSnapshot(current);
    // A paid→paid switch keeps the billing period and prorates; a free→paid
    // upgrade starts a fresh cycle today (nothing to prorate on ₱0).
    const keepPeriod = previous !== null && previous.price_cents > 0;
    let result = await this.subscriptions.changePlan(tx, organizationId, { planKey: plan.key, provider: this.providerName, keepPeriod });
    const adjustment = keepPeriod ? prorationAdjustment(previous, result.subscription, plan) : null;
    if (adjustment !== null) {
      const updated = await this.subscriptionRows.update(tx, result.subscription.id, {
        pending_adjustments: [...result.subscription.pending_adjustments, adjustment],
      });
      result = { subscription: updated, plan: result.plan };
      this.logger.log(`plan change prorated org=${organizationId} net_cents=${String(adjustment.amount_cents)} ${String(adjustment.from_plan)}→${String(adjustment.to_plan)}`);
    }
    await this.entitlements.invalidate(tx, organizationId);
    return result;
  }

  /**
   * Hosted provider with an existing provider subscription: the provider owns
   * proration and invoicing, so it is told first and the local row follows its
   * answer (the period is kept — the provider's cycle is the truth).
   */
  protected async changePlanWithProvider(tx: Tx, organizationId: string, current: SubscriptionRow, plan: PlanWithDetails): Promise<SubscriptionWithPlan> {
    const ref = await this.provider().changePlan(current.provider_subscription_id as string, {
      planKey: plan.key,
      priceCents: plan.price_cents ?? 0,
      currency: plan.currency,
      interval: plan.interval ?? "month",
    });
    return this.subscriptions.changePlan(tx, organizationId, {
      planKey: plan.key,
      provider: this.providerName,
      providerSubscriptionId: ref.providerSubscriptionId,
      keepPeriod: true,
    });
  }
}
