/**
 * Entitlement resolution — the heart of pricing-as-config (transliterated
 * from the reference's `entitlements/resolver.py`). A pure function: rows in,
 * effective feature/limit set out. No I/O.
 *
 * 1. Plan features apply iff subscription status ∈ {trialing, active, past_due}
 *    (past_due = grace, configurable).
 * 2. Grants apply when un-revoked and inside their time window.
 * 3. Conflicts resolve by source priority; a winning grant with enabled=false
 *    REMOVES the feature (kill switch).
 * 4. Limits merge plan limits overridden per metric by grants of the synthetic
 *    feature key `limit:<metric>`.
 */

export const LIMIT_FEATURE_PREFIX = "limit:";
export const PLAN_SOURCE = "plan";

export const ENTITLEMENT_SOURCES = ["trial", "addon", "promo", "beta", "override", "enterprise", "grandfather"] as const;

/** Higher wins on conflict; a winning enabled=false grant removes a plan feature. */
export const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  plan: 0,
  addon: 10,
  beta: 20,
  promo: 30,
  grandfather: 40,
  override: 50,
  enterprise: 60,
};

/** Projection of an entitlements-table row. `limitValue` is only meaningful for `limit:<metric>` grants. */
export interface EntitlementGrant {
  readonly featureKey: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly revokedAt?: Date | null;
  readonly limitValue?: number | null;
}

/** Billing for usage past the limit: `priceCents` per `unit` units, rounded up. */
export class Overage {
  constructor(
    readonly unit: number,
    readonly priceCents: number,
  ) {}

  /** [billable quantity in `unit` blocks, amount in cents] — reconciles as qty × price. */
  bill(unitsOver: number): [number, number] {
    if (unitsOver <= 0) return [0, 0];
    const quantity = Math.ceil(unitsOver / this.unit);
    return [quantity, quantity * this.priceCents];
  }

  equals(other: Overage | null | undefined): boolean {
    return !!other && other.unit === this.unit && other.priceCents === this.priceCents;
  }
}

export class Limit {
  constructor(
    /** null ⇒ unlimited */
    readonly value: number | null,
    readonly softLimitRatio: number | null,
    /** null ⇒ past-limit usage is never billed */
    readonly overage: Overage | null = null,
  ) {}

  get isUnlimited(): boolean {
    return this.value === null;
  }
}

export interface EntitlementInputs {
  readonly organizationId: string;
  readonly now: Date;
  readonly planKey?: string | null;
  readonly subscriptionStatus?: string | null;
  readonly planFeatures?: ReadonlySet<string>;
  readonly planLimits?: ReadonlyMap<string, Limit>;
  readonly grants?: readonly EntitlementGrant[];
  /** Catalog default overage per metric — used when a limit has no price of its own. */
  readonly metricOverage?: ReadonlyMap<string, Overage>;
  readonly graceOnPastDue?: boolean;
}

export class EffectiveEntitlements {
  constructor(
    readonly organizationId: string,
    readonly planKey: string | null,
    readonly subscriptionStatus: string | null,
    readonly features: ReadonlySet<string>,
    readonly limits: ReadonlyMap<string, Limit>,
  ) {}

  has(feature: string): boolean {
    return this.features.has(feature);
  }

  limit(metric: string): Limit | null {
    return this.limits.get(metric) ?? null;
  }

  limitValue(metric: string): number | null {
    return this.limits.get(metric)?.value ?? null;
  }

  withinLimit(metric: string, used: number): boolean {
    const limit = this.limits.get(metric);
    if (!limit || limit.value === null) return true;
    return used < limit.value;
  }

  /** The `EffectiveEntitlementsRead` wire shape. */
  toRead(): EffectiveEntitlementsRead {
    const limits: Record<string, { value: number | null; soft_limit_ratio: number | null }> = {};
    for (const [metric, limit] of this.limits) limits[metric] = { value: limit.value, soft_limit_ratio: limit.softLimitRatio };
    return {
      organization_id: this.organizationId,
      plan_key: this.planKey,
      subscription_status: this.subscriptionStatus,
      features: [...this.features].sort(),
      limits,
    };
  }
}

export interface EffectiveEntitlementsRead {
  organization_id: string;
  plan_key: string | null;
  subscription_status: string | null;
  features: string[];
  limits: Record<string, { value: number | null; soft_limit_ratio: number | null }>;
}

function grantIsActive(grant: EntitlementGrant, now: Date): boolean {
  if (grant.revokedAt) return false;
  if (grant.startsAt.getTime() > now.getTime()) return false;
  return grant.endsAt === null || now.getTime() < grant.endsAt.getTime();
}

export function resolveEffective(inputs: EntitlementInputs): EffectiveEntitlements {
  // ── 1. plan features in effect? ────────────────────────────────────────────
  const status = inputs.subscriptionStatus ?? null;
  const occupying = new Set(["trialing", "active", ...(inputs.graceOnPastDue ?? true ? ["past_due"] : [])]);
  const planActive = status !== null && occupying.has(status);

  // ── 2. active grants ────────────────────────────────────────────────────────
  const activeGrants = (inputs.grants ?? []).filter((g) => grantIsActive(g, inputs.now));

  // ── 3. features: plan set, then grant overlay by priority ──────────────────
  const decisions = new Map<string, { priority: number; enabled: boolean }>();
  if (planActive) for (const feature of inputs.planFeatures ?? []) decisions.set(feature, { priority: SOURCE_PRIORITY[PLAN_SOURCE] ?? 0, enabled: true });
  for (const grant of activeGrants) {
    if (grant.featureKey.startsWith(LIMIT_FEATURE_PREFIX)) continue; // handled in the limit pass
    const priority = SOURCE_PRIORITY[grant.source] ?? 0;
    const current = decisions.get(grant.featureKey);
    if (!current || priority > current.priority) decisions.set(grant.featureKey, { priority, enabled: grant.enabled });
  }
  const features = new Set([...decisions].filter(([, d]) => d.enabled).map(([feature]) => feature));

  // ── 4. limits: plan limits, then `limit:<metric>` grants override ──────────
  const limits = new Map<string, Limit>(planActive ? inputs.planLimits ?? [] : []);
  for (const grant of activeGrants) {
    if (!grant.featureKey.startsWith(LIMIT_FEATURE_PREFIX) || !grant.enabled) continue;
    const metric = grant.featureKey.slice(LIMIT_FEATURE_PREFIX.length);
    const base = limits.get(metric) ?? new Limit(null, null);
    limits.set(
      metric,
      new Limit(
        grant.limitValue ?? base.value,
        base.softLimitRatio,
        // an addon raises the cap; the plan (else the metric) still prices overage
        base.overage ?? inputs.metricOverage?.get(metric) ?? null,
      ),
    );
  }

  return new EffectiveEntitlements(inputs.organizationId, inputs.planKey ?? null, status, features, limits);
}
