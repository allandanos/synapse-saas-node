import { Inject, Injectable } from "@nestjs/common";
import { CACHE_NAMESPACES, CacheRegistry } from "../core/cache/cache.registry";
import type { VersionedCache } from "../core/cache/versioned-cache";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import { EntitlementNotFoundError, FeatureNotEntitledError } from "../core/errors";
import { events } from "../core/events";
import { OutboxWriter } from "../core/outbox";
import { PlansRepository, type PlanWithDetails } from "../subscriptions/plans.repository";
import { SubscriptionsRepository } from "../subscriptions/subscriptions.repository";
import { type EntitlementRow, EntitlementsRepository } from "./entitlements.repository";
import { EffectiveEntitlements, type EntitlementGrant, Limit, Overage, resolveEffective } from "./resolver";

export const UPGRADE_URL = "/dashboard/billing";

/**
 * Assembles resolver inputs from the database and manages grants
 * (transliterated from the reference's `entitlements/service.py`).
 *
 * The resolution is memoised in the versioned `entl` cache (60 s) and bumped
 * by every subscription, grant or webhook change — including from
 * `SubscriptionsService` and `BillingService`, which hold the same namespace.
 */
@Injectable()
export class EntitlementsService {
  private readonly cache: VersionedCache;

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly plans: PlansRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly entitlements: EntitlementsRepository,
    private readonly outbox: OutboxWriter,
    caches: CacheRegistry,
  ) {
    this.cache = caches.namespace(CACHE_NAMESPACES.ENTITLEMENTS);
  }

  /** Grants, plan changes and webhook transitions all land here. */
  invalidate(tx: Tx, organizationId: string): Promise<void> {
    return this.cache.invalidate(tx, organizationId);
  }

  /** Out-of-transaction invalidation: worker jobs, after their own commit. */
  async invalidateAfterCommit(organizationId: string): Promise<void> {
    await this.cache.bump(organizationId);
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  effectiveForOrganization(organizationId: string): Promise<EffectiveEntitlements> {
    return this.db.transaction((tx) => this.effectiveForOrg(tx, organizationId));
  }

  async effectiveForOrg(tx: Tx, organizationId: string): Promise<EffectiveEntitlements> {
    const [cached, version] = await this.cache.getVersioned(organizationId);
    if (cached !== null) {
      const hit = deserializeEffective(cached);
      if (hit) return hit; // a corrupt body just recomputes
    }
    const effective = await this.compute(tx, organizationId);
    // Store under the version seen at READ time: a bump in between leaves the
    // new version empty instead of filling it with this (now stale) body.
    await this.cache.set(organizationId, serializeEffective(effective), version);
    return effective;
  }

  private async compute(tx: Tx, organizationId: string): Promise<EffectiveEntitlements> {
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
    await this.invalidate(tx, organizationId);
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
    await this.invalidate(tx, row.organization_id);
    return row;
  }
}

// ── Cache body ───────────────────────────────────────────────────────────────

/** The cached shape mirrors the reference's `_serialize` exactly. */
function serializeEffective(effective: EffectiveEntitlements): string {
  const limits: Record<string, unknown> = {};
  for (const [metric, limit] of effective.limits) {
    limits[metric] = {
      value: limit.value,
      soft_limit_ratio: limit.softLimitRatio,
      overage: limit.overage ? { unit: limit.overage.unit, price_cents: limit.overage.priceCents } : null,
    };
  }
  return JSON.stringify({
    organization_id: effective.organizationId,
    plan_key: effective.planKey,
    subscription_status: effective.subscriptionStatus,
    features: [...effective.features].sort(),
    limits,
  });
}

interface SerializedLimit {
  value: number | null;
  soft_limit_ratio: number | null;
  overage: { unit: number; price_cents: number } | null;
}

function deserializeEffective(raw: string): EffectiveEntitlements | null {
  try {
    const data = JSON.parse(raw) as {
      organization_id: string;
      plan_key: string | null;
      subscription_status: string | null;
      features: string[];
      limits: Record<string, SerializedLimit>;
    };
    const limits = new Map<string, Limit>();
    for (const [metric, limit] of Object.entries(data.limits)) {
      limits.set(metric, new Limit(limit.value, limit.soft_limit_ratio, limit.overage ? new Overage(limit.overage.unit, limit.overage.price_cents) : null));
    }
    return new EffectiveEntitlements(data.organization_id, data.plan_key, data.subscription_status, new Set(data.features), limits);
  } catch {
    return null;
  }
}
