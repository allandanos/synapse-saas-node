import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import { EntitlementNotFoundError, FeatureNotEntitledError } from "../core/errors";
import { events } from "../core/events";
import { OutboxWriter } from "../core/outbox";
import { PlansRepository, type PlanWithDetails } from "../subscriptions/plans.repository";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { type EntitlementRow, EntitlementsRepository } from "./entitlements.repository";
import { type EffectiveEntitlements, type EntitlementGrant, Limit, Overage, resolveEffective } from "./resolver";

export const UPGRADE_URL = "/dashboard/billing";

/**
 * Assembles resolver inputs from the database and manages grants
 * (transliterated from the reference's `entitlements/service.py`).
 *
 * Caching seam: the reference memoises `effective_for_org` in a versioned
 * Redis cache bumped on every subscription/grant change. This port computes
 * the set per call (a few indexed reads inside the caller's transaction); a
 * cache slots in behind `effectiveForOrg` without touching callers.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly plans: PlansRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly entitlements: EntitlementsRepository,
    private readonly outbox: OutboxWriter,
  ) {}

  /**
   * Cache-invalidation seam. The reference bumps a versioned Redis key here
   * (grants, plan changes, webhook transitions, expiry); this port resolves
   * entitlements per call, so the seam is a no-op that keeps the call sites
   * honest — a cache slots in behind it without touching any caller.
   */
  invalidate(_organizationId: string): void {
    return;
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  effectiveForOrganization(organizationId: string): Promise<EffectiveEntitlements> {
    return this.db.transaction((tx) => this.effectiveForOrg(tx, organizationId));
  }

  async effectiveForOrg(tx: Tx, organizationId: string): Promise<EffectiveEntitlements> {
    const subscription = await this.subscriptions.currentForOrganization(tx, organizationId);
    let plan: PlanWithDetails | undefined;
    if (subscription) {
      plan = await this.plans.findById(tx, subscription.plan_id);
    } else {
      // No occupying subscription ⇒ the default plan, so a fresh org resolves
      // sensible features/limits; an unseeded catalog ⇒ no plan features/limits.
      plan = await this.plans.findByKey(tx, this.settings.SYNAPSE_DEFAULT_PLAN_KEY);
    }
    const grants: EntitlementGrant[] = (await this.entitlements.activeForOrganization(tx, organizationId)).map((row) => ({
      featureKey: row.feature_key,
      source: row.source,
      enabled: row.enabled,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      revokedAt: row.revoked_at,
      limitValue: row.limit_value,
    }));
    const planLimits = new Map<string, Limit>();
    for (const limit of plan?.limits ?? []) {
      planLimits.set(
        limit.metric,
        new Limit(
          limit.limit_value,
          limit.soft_limit_ratio ? limit.soft_limit_ratio : null,
          limit.overage_unit !== null && limit.overage_price_cents !== null ? new Overage(limit.overage_unit, limit.overage_price_cents) : null,
        ),
      );
    }
    const metricOverage = new Map<string, Overage>();
    for (const metric of await this.plans.metricsWithOverage(tx)) {
      metricOverage.set(metric.key, new Overage(metric.overage_unit ?? 1, metric.overage_price_cents ?? 0));
    }
    return resolveEffective({
      organizationId,
      now: new Date(),
      planKey: plan?.key ?? null,
      subscriptionStatus: subscription?.status ?? null,
      planFeatures: new Set((plan?.features ?? []).map((f) => f.feature_key)),
      planLimits,
      grants,
      metricOverage,
      graceOnPastDue: this.settings.SYNAPSE_GRACE_ON_PAST_DUE,
    });
  }

  /** 403 `feature_not_entitled` with upgrade hints when the org lacks `feature`. */
  async requireFeature(tx: Tx, organizationId: string, feature: string): Promise<EffectiveEntitlements> {
    const effective = await this.effectiveForOrg(tx, organizationId);
    if (effective.has(feature)) return effective;
    throw new FeatureNotEntitledError(`Feature '${feature}' is not available on the current plan`, {
      feature,
      current_plan: effective.planKey,
      available_in: await this.plans.plansWithFeature(tx, feature),
      upgrade_url: UPGRADE_URL,
    });
  }

  // ── Grant management (operator surface) ─────────────────────────────────────

  async grant(
    tx: Tx,
    organizationId: string,
    input: {
      featureKey: string;
      source: string;
      durationDays?: number | null;
      enabled?: boolean;
      note?: string | null;
      limitValue?: number | null;
      createdByUserId?: string | null;
    },
  ): Promise<EntitlementRow> {
    const now = new Date();
    const endsAt = input.durationDays ? new Date(now.getTime() + input.durationDays * 86_400_000) : null;
    const row = await this.entitlements.insert(tx, {
      organizationId,
      featureKey: input.featureKey,
      source: input.source,
      enabled: input.enabled ?? true,
      startsAt: now,
      endsAt,
      note: input.note ?? null,
      limitValue: input.limitValue ?? null,
      createdByUserId: input.createdByUserId ?? null,
    });
    await this.outbox.append(tx, {
      eventType: events.ENTITLEMENT_GRANTED,
      aggregateType: "entitlement",
      aggregateId: row.id,
      organizationId,
      payload: { feature_key: input.featureKey, source: input.source, ends_at: endsAt ? endsAt.toISOString() : null, limit_value: input.limitValue ?? null },
    });
    this.invalidate(organizationId);
    return row;
  }

  async get(tx: Tx, entitlementId: string): Promise<EntitlementRow> {
    const row = await this.entitlements.findById(tx, entitlementId);
    if (!row) throw new EntitlementNotFoundError("Grant not found", { entitlement_id: entitlementId });
    return row;
  }

  async revoke(tx: Tx, entitlementId: string): Promise<EntitlementRow> {
    const row = await this.entitlements.findById(tx, entitlementId);
    if (!row) throw new EntitlementNotFoundError("Entitlement not found");
    await this.entitlements.revoke(tx, row.id, new Date());
    await this.outbox.append(tx, {
      eventType: events.ENTITLEMENT_REVOKED,
      aggregateType: "entitlement",
      aggregateId: row.id,
      organizationId: row.organization_id,
      payload: { feature_key: row.feature_key },
    });
    this.invalidate(row.organization_id);
    return row;
  }
}
