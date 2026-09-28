import { Injectable } from "@nestjs/common";
import { AuditWriter } from "../core/audit";
import type { Tx } from "../core/db/database";
import { PlanNotFoundError, SubscriptionNotFoundError, TrialNotAllowedError } from "../core/errors";
import { events } from "../core/events";
import { OutboxWriter } from "../core/outbox";
import { type PlanRead, PlansRepository, type PlanWithDetails, toPlanRead } from "./plans.repository";
import { assertTransition } from "./state-machine";
import { type SubscriptionRow, SubscriptionsRepository } from "./subscriptions.repository";

export const MONTH_MS = 30 * 86_400_000;
export const YEAR_MS = 365 * 86_400_000;

export interface SubscriptionRead {
  id: string;
  organization_id: string;
  plan_id: string;
  plan: PlanRead;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  trial_ends_at: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  plan_snapshot: Record<string, unknown>;
}

/** A subscription row with its plan loaded (responses serialise plan features/limits). */
export interface SubscriptionWithPlan {
  subscription: SubscriptionRow;
  plan: PlanWithDetails;
}

export function toSubscriptionRead({ subscription, plan }: SubscriptionWithPlan): SubscriptionRead {
  return {
    id: subscription.id,
    organization_id: subscription.organization_id,
    plan_id: subscription.plan_id,
    plan: toPlanRead(plan),
    status: subscription.status,
    current_period_start: subscription.current_period_start,
    current_period_end: subscription.current_period_end,
    trial_ends_at: subscription.trial_ends_at,
    cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at,
    plan_snapshot: subscription.plan_snapshot,
  };
}

/** Freeze purchase-time pricing/features so later YAML edits never rewrite history. */
export function planSnapshot(plan: PlanWithDetails): Record<string, unknown> {
  const overage: Record<string, { unit: number; price_cents: number }> = {};
  for (const limit of plan.limits) {
    if (limit.overage_unit !== null && limit.overage_price_cents !== null) {
      overage[limit.metric] = { unit: limit.overage_unit, price_cents: limit.overage_price_cents };
    }
  }
  return {
    key: plan.key,
    name: plan.name,
    price_cents: plan.price_cents,
    currency: plan.currency,
    interval: plan.interval,
    features: plan.features.filter((f) => f.enabled).map((f) => f.feature_key),
    limits: Object.fromEntries(plan.limits.map((l) => [l.metric, l.limit_value])),
    overage,
  };
}

/**
 * Subscription lifecycle: create, trial, plan change, cancel/resume
 * (transliterated from the reference's `subscriptions/service.py`). Every
 * method runs inside the caller's transaction — the route or the org-creation
 * flow owns it — so the outbox/audit rows commit with the change. Plan changes
 * capture a `plan_snapshot` (grandfathering). The entitlement cache bump of the
 * reference has no counterpart yet: entitlements are computed per request.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly plans: PlansRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  // ── Queries ─────────────────────────────────────────────────────────────────

  async currentForOrganization(tx: Tx, organizationId: string): Promise<SubscriptionWithPlan | null> {
    const subscription = await this.subscriptions.currentForOrganization(tx, organizationId);
    if (!subscription) return null;
    const plan = await this.plans.findById(tx, subscription.plan_id);
    if (!plan) throw new PlanNotFoundError(`Plan ${subscription.plan_id} of subscription ${subscription.id} is missing`);
    return { subscription, plan };
  }

  /** Plan with features/limits loaded, or 404 `plan_not_found`. */
  async planByKey(tx: Tx, key: string, options: { includeArchived?: boolean } = {}): Promise<PlanWithDetails> {
    const plan = await this.plans.findByKey(tx, key, options);
    if (!plan) throw new PlanNotFoundError(`Plan '${key}' not found`);
    return plan;
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  async createSubscription(
    tx: Tx,
    input: {
      organizationId: string;
      plan: PlanWithDetails;
      status?: string;
      currentPeriodStart?: Date;
      currentPeriodEnd?: Date;
      trialEndsAt?: Date | null;
      provider?: string | null;
      providerSubscriptionId?: string | null;
      billingCustomerId?: string | null;
    },
  ): Promise<SubscriptionWithPlan> {
    const status = input.status ?? "active";
    const start = input.currentPeriodStart ?? new Date();
    const end = input.currentPeriodEnd ?? new Date(start.getTime() + intervalMs(input.plan.interval));
    const subscription = await this.subscriptions.insert(tx, {
      organizationId: input.organizationId,
      planId: input.plan.id,
      status,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      trialEndsAt: input.trialEndsAt ?? null,
      provider: input.provider ?? null,
      providerSubscriptionId: input.providerSubscriptionId ?? null,
      billingCustomerId: input.billingCustomerId ?? null,
      planSnapshot: planSnapshot(input.plan),
    });
    const eventType = status === "trialing" ? events.SUBSCRIPTION_TRIAL_STARTED : events.SUBSCRIPTION_ACTIVATED;
    await this.emit(tx, eventType, subscription, input.plan, { organization_id: input.organizationId });
    return { subscription, plan: input.plan };
  }

  /** Replace the occupying subscription with a trialing one on `planKey`. */
  async startTrial(tx: Tx, organizationId: string, planKey: string, trialDays: number | null = null): Promise<SubscriptionWithPlan> {
    const plan = await this.planByKey(tx, planKey);
    if (plan.trial_days === 0 && trialDays === null) throw new TrialNotAllowedError(`Plan '${planKey}' has no trial period`);
    const existing = await this.subscriptions.currentForOrganization(tx, organizationId);
    if (existing && existing.status === "trialing") throw new TrialNotAllowedError("A trial is already in progress for this organization");

    const days = trialDays ?? plan.trial_days;
    const now = new Date();
    const trialEnd = new Date(now.getTime() + days * 86_400_000);
    if (existing) {
      // End the current subscription, then trial on top
      assertTransition(existing.status, "canceled");
      await this.subscriptions.update(tx, existing.id, { status: "canceled", canceled_at: now });
    }
    const created = await this.createSubscription(tx, {
      organizationId,
      plan,
      status: "trialing",
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      trialEndsAt: trialEnd,
    });
    await this.audit.log(tx, {
      eventType: events.SUBSCRIPTION_TRIAL_STARTED,
      organizationId,
      targetType: "subscription",
      targetId: created.subscription.id,
      diff: { plan: planKey, trial_days: days },
    });
    return created;
  }

  /**
   * Switch the occupying subscription to a new plan immediately. `keepPeriod`
   * (mid-period change): the current billing period is kept so the caller can
   * prorate the difference; the period only resets when there is no live
   * period to keep (trial, lapsed, new).
   */
  async changePlan(
    tx: Tx,
    organizationId: string,
    input: { planKey: string; provider?: string | null; providerSubscriptionId?: string | null; keepPeriod?: boolean },
  ): Promise<SubscriptionWithPlan> {
    const plan = await this.planByKey(tx, input.planKey);
    const existing = await this.subscriptions.currentForOrganization(tx, organizationId);
    const now = new Date();
    if (!existing) {
      return this.createSubscription(tx, {
        organizationId,
        plan,
        status: "active",
        provider: input.provider ?? null,
        providerSubscriptionId: input.providerSubscriptionId ?? null,
      });
    }
    const fromSnapshot = existing.plan_snapshot.key;
    const patch: Parameters<SubscriptionsRepository["update"]>[2] = {
      status: "active",
      plan_id: plan.id,
      plan_snapshot: planSnapshot(plan),
      cancel_at_period_end: false,
      canceled_at: null,
    };
    // The reference re-asserts `active` before this test, so only the period end decides.
    const periodIsLive = existing.current_period_end.getTime() > now.getTime();
    if (!(input.keepPeriod && periodIsLive)) {
      patch.current_period_start = now;
      patch.current_period_end = new Date(now.getTime() + intervalMs(plan.interval));
    }
    if (input.provider != null) patch.provider = input.provider;
    if (input.providerSubscriptionId != null) patch.provider_subscription_id = input.providerSubscriptionId;
    const updated = await this.subscriptions.update(tx, existing.id, patch);

    await this.emit(tx, events.SUBSCRIPTION_PLAN_CHANGED, updated, plan, { from_plan: String(fromSnapshot), to_plan: plan.key });
    await this.audit.log(tx, {
      eventType: events.SUBSCRIPTION_PLAN_CHANGED,
      organizationId,
      targetType: "subscription",
      targetId: updated.id,
      diff: { from: fromSnapshot ?? null, to: plan.key },
    });
    return { subscription: updated, plan };
  }

  async cancel(tx: Tx, organizationId: string, atPeriodEnd = true): Promise<SubscriptionWithPlan> {
    const current = await this.requireCurrent(tx, organizationId);
    assertTransition(current.subscription.status, "canceled");
    const updated = await this.subscriptions.update(
      tx,
      current.subscription.id,
      atPeriodEnd ? { cancel_at_period_end: true } : { status: "canceled", canceled_at: new Date() },
    );
    await this.emit(tx, events.SUBSCRIPTION_CANCELED, updated, current.plan);
    await this.audit.log(tx, {
      eventType: events.SUBSCRIPTION_CANCELED,
      organizationId,
      targetType: "subscription",
      targetId: updated.id,
      diff: { at_period_end: atPeriodEnd },
    });
    return { subscription: updated, plan: current.plan };
  }

  async resume(tx: Tx, organizationId: string): Promise<SubscriptionWithPlan> {
    const current = await this.requireCurrent(tx, organizationId);
    if (!current.subscription.cancel_at_period_end) throw new SubscriptionNotFoundError("Subscription is not scheduled for cancellation");
    const updated = await this.subscriptions.update(tx, current.subscription.id, { cancel_at_period_end: false });
    await this.emit(tx, events.SUBSCRIPTION_RESUMED, updated, current.plan);
    return { subscription: updated, plan: current.plan };
  }

  /** Webhook-driven status change (milestone 4 wires the callers); idempotent and transition-checked. */
  async applyProviderTransition(tx: Tx, subscription: SubscriptionRow, targetStatus: string, currentPeriodEnd?: Date): Promise<SubscriptionRow> {
    assertTransition(subscription.status, targetStatus);
    return this.subscriptions.update(tx, subscription.id, { status: targetStatus, ...(currentPeriodEnd ? { current_period_end: currentPeriodEnd } : {}) });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async requireCurrent(tx: Tx, organizationId: string): Promise<SubscriptionWithPlan> {
    const current = await this.currentForOrganization(tx, organizationId);
    if (!current) throw new SubscriptionNotFoundError("No active subscription for this organization");
    return current;
  }

  private async emit(tx: Tx, eventType: string, subscription: SubscriptionRow, plan: PlanWithDetails, extra: Record<string, unknown> = {}): Promise<void> {
    await this.outbox.append(tx, {
      eventType,
      aggregateType: "subscription",
      aggregateId: subscription.id,
      organizationId: subscription.organization_id,
      payload: {
        subscription_id: subscription.id,
        organization_id: subscription.organization_id,
        plan_key: plan.key,
        status: subscription.status,
        ...extra,
      },
    });
  }
}

export function intervalMs(interval: string | null): number {
  return interval === "year" ? YEAR_MS : MONTH_MS;
}
