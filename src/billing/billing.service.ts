import { Inject, Injectable, Logger } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import { BillingProviderNotConfiguredError, CheckoutRequiredError } from "../core/errors";
import type { PlanWithDetails } from "../subscriptions/plans.repository";
import { arrearsAdjustmentCents, prorate } from "../subscriptions/proration";
import { SubscriptionsRepository, type SubscriptionRow } from "../subscriptions/subscriptions.repository";
import { SubscriptionsService, type SubscriptionWithPlan } from "../subscriptions/subscriptions.service";
import { BillingCapability, capabilitiesOf } from "./providers";

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

/**
 * Plan changes through the active provider (the reference's
 * `BillingService.change_plan`, ADR 0004). Customers, checkout, invoices and
 * the provider clients arrive with milestone 4.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly subscriptions: SubscriptionsService,
    private readonly subscriptionRows: SubscriptionsRepository,
  ) {}

  get providerName(): string {
    return this.settings.SYNAPSE_BILLING_PROVIDER;
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
      return this.changePlanWithProvider(tx, organizationId, current, plan);
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
    return result;
  }

  /**
   * MILESTONE 4 SEAM — hosted provider with an existing provider subscription:
   * call `provider.change_plan(provider_subscription_id, {plan_key, price_cents,
   * currency, interval})`, then `subscriptions.changePlan(…, {provider,
   * providerSubscriptionId: ref.provider_subscription_id, keepPeriod: true})`.
   * The provider clients do not exist yet, so the branch is refused explicitly
   * rather than pretending the provider was told.
   */
  protected changePlanWithProvider(_tx: Tx, _organizationId: string, _current: SubscriptionRow, _plan: PlanWithDetails): Promise<SubscriptionWithPlan> {
    throw new BillingProviderNotConfiguredError(`${this.providerName} plan changes need the provider client (milestone 4)`, { provider: this.providerName });
  }
}
