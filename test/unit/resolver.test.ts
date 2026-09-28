import { describe, expect, it } from "vitest";
import { newUuid } from "../../src/core/ids";
import { type EntitlementGrant, type EntitlementInputs, Limit, Overage, resolveEffective } from "../../src/entitlements/resolver";

/** Transliterated from the reference's tests/unit/entitlements/test_resolver.py — every pricing behaviour the framework promises. */
const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 7, 31, 12, 0));
const PLAN_FEATURES = new Set(["basic_dashboard", "api_access", "advanced_reports"]);
const PLAN_LIMITS = new Map<string, Limit>([
  ["users", new Limit(10, null)],
  ["api_requests", new Limit(100_000, 0.8)],
  ["storage_bytes", new Limit(null, null)], // unlimited
]);

function inputs(overrides: Partial<EntitlementInputs> = {}): EntitlementInputs {
  return {
    organizationId: newUuid(),
    now: NOW,
    planKey: "pro",
    subscriptionStatus: "active",
    planFeatures: PLAN_FEATURES,
    planLimits: PLAN_LIMITS,
    grants: [],
    ...overrides,
  };
}

function grant(
  featureKey: string,
  source = "override",
  options: { enabled?: boolean; startsAt?: Date; endsAt?: Date | null; revokedAt?: Date | null; limitValue?: number | null } = {},
): EntitlementGrant {
  return {
    featureKey,
    source,
    enabled: options.enabled ?? true,
    startsAt: options.startsAt ?? new Date(NOW.getTime() - DAY),
    endsAt: options.endsAt ?? null,
    revokedAt: options.revokedAt ?? null,
    limitValue: options.limitValue ?? null,
  };
}

describe("plan features", () => {
  it("active subscription has plan features", () => {
    const result = resolveEffective(inputs());
    expect(result.has("advanced_reports")).toBe(true);
    expect(result.features).toEqual(PLAN_FEATURES);
  });

  it.each(["trialing", "past_due"])("%s keeps features", (status) => {
    expect(resolveEffective(inputs({ subscriptionStatus: status })).has("advanced_reports")).toBe(true);
  });

  it("past_due grace disabled", () => {
    const result = resolveEffective(inputs({ subscriptionStatus: "past_due", graceOnPastDue: false }));
    expect(result.has("advanced_reports")).toBe(false);
    expect(result.features.size).toBe(0);
  });

  it.each(["canceled", "unpaid", "incomplete"])("dead status %s loses features and limits", (status) => {
    const result = resolveEffective(inputs({ subscriptionStatus: status }));
    expect(result.features.size).toBe(0);
    expect(result.limits.size).toBe(0);
  });

  it("no subscription, no features", () => {
    expect(resolveEffective(inputs({ subscriptionStatus: null, planKey: null })).features.size).toBe(0);
  });
});

describe("grants", () => {
  it("trial grant adds a feature independent of the plan", () => {
    const result = resolveEffective(inputs({ subscriptionStatus: "canceled", grants: [grant("advanced_reports", "trial", { endsAt: new Date(NOW.getTime() + 14 * DAY) })] }));
    expect(result.has("advanced_reports")).toBe(true);
  });

  it("expired, future and revoked grants are ignored", () => {
    expect(resolveEffective(inputs({ grants: [grant("beta_feature", "beta", { endsAt: new Date(NOW.getTime() - DAY) })] })).has("beta_feature")).toBe(false);
    expect(resolveEffective(inputs({ grants: [grant("beta_feature", "beta", { startsAt: new Date(NOW.getTime() + DAY) })] })).has("beta_feature")).toBe(false);
    expect(resolveEffective(inputs({ grants: [grant("beta_feature", "beta", { revokedAt: new Date(NOW.getTime() - 3_600_000) })] })).has("beta_feature")).toBe(false);
  });

  it("disabled grant kills a plan feature (the kill switch)", () => {
    const result = resolveEffective(inputs({ grants: [grant("advanced_reports", "override", { enabled: false })] }));
    expect(result.has("advanced_reports")).toBe(false);
    expect(result.has("basic_dashboard")).toBe(true);
  });

  it("priority: enterprise beats override; higher source wins regardless of order", () => {
    expect(
      resolveEffective(inputs({ grants: [grant("advanced_reports", "override", { enabled: false }), grant("advanced_reports", "enterprise", { enabled: true })] })).has(
        "advanced_reports",
      ),
    ).toBe(true);
    expect(
      resolveEffective(inputs({ grants: [grant("beta_feature", "enterprise", { enabled: false }), grant("beta_feature", "promo", { enabled: true })] })).has("beta_feature"),
    ).toBe(false);
  });

  it("grant works with no plan at all", () => {
    expect(resolveEffective(inputs({ subscriptionStatus: null, planKey: null, grants: [grant("sso", "enterprise")] })).has("sso")).toBe(true);
  });
});

describe("limits", () => {
  it("plan limits resolved", () => {
    const result = resolveEffective(inputs());
    expect(result.limitValue("users")).toBe(10);
    expect(result.limitValue("api_requests")).toBe(100_000);
    expect(result.limit("api_requests")?.softLimitRatio).toBe(0.8);
  });

  it("unlimited and unknown metrics", () => {
    const result = resolveEffective(inputs());
    expect(result.limit("storage_bytes")?.isUnlimited).toBe(true);
    expect(result.withinLimit("storage_bytes", 10 ** 12)).toBe(true);
    expect(result.limit("ai_tokens")).toBeNull();
    expect(result.withinLimit("ai_tokens", 10 ** 9)).toBe(true);
  });

  it("within-limit boundary", () => {
    const result = resolveEffective(inputs());
    expect(result.withinLimit("users", 9)).toBe(true);
    expect(result.withinLimit("users", 10)).toBe(false);
  });

  it("limit addon grant raises the cap and keeps the soft ratio", () => {
    const result = resolveEffective(inputs({ grants: [grant("limit:api_requests", "addon", { limitValue: 500_000 })] }));
    expect(result.limitValue("api_requests")).toBe(500_000);
    expect(result.limit("api_requests")?.softLimitRatio).toBe(0.8);
  });

  it("limit grant on a dead subscription; disabled limit grant ignored", () => {
    expect(resolveEffective(inputs({ subscriptionStatus: "canceled", grants: [grant("limit:api_requests", "addon", { limitValue: 50 })] })).limitValue("api_requests")).toBe(50);
    expect(resolveEffective(inputs({ grants: [grant("limit:api_requests", "addon", { enabled: false, limitValue: 500_000 })] })).limitValue("api_requests")).toBe(100_000);
  });

  it("carries plan and status; the read shape sorts features", () => {
    const result = resolveEffective(inputs());
    expect(result.planKey).toBe("pro");
    expect(result.subscriptionStatus).toBe("active");
    const read = result.toRead();
    expect(read.features).toEqual(["advanced_reports", "api_access", "basic_dashboard"]);
    expect(read.limits.api_requests).toEqual({ value: 100_000, soft_limit_ratio: 0.8 });
  });
});

describe("overage rides on the limit", () => {
  it("bill rounds up to whole blocks and reconciles", () => {
    const overage = new Overage(1000, 20);
    expect(overage.bill(0)).toEqual([0, 0]);
    expect(overage.bill(1)).toEqual([1, 20]); // a partial block is a whole block
    expect(overage.bill(4000)).toEqual([4, 80]);
    expect(overage.bill(4001)).toEqual([5, 100]);
    const [quantity, amount] = overage.bill(123_456);
    expect(quantity * overage.priceCents).toBe(amount);
  });

  it("addon limit falls back to the metric default price", () => {
    const now = new Date(Date.UTC(2026, 8, 28));
    const limit = resolveEffective({
      organizationId: newUuid(),
      now,
      planKey: "free",
      subscriptionStatus: "active",
      planLimits: new Map(),
      grants: [{ featureKey: "limit:ai_tokens", source: "addon", enabled: true, startsAt: now, endsAt: null, limitValue: 1000 }],
      metricOverage: new Map([["ai_tokens", new Overage(1000, 20)]]),
    }).limit("ai_tokens");
    expect(limit?.value).toBe(1000);
    expect(limit?.overage?.equals(new Overage(1000, 20))).toBe(true);
  });

  it("plan price beats the metric default", () => {
    const now = new Date(Date.UTC(2026, 8, 28));
    const limit = resolveEffective({
      organizationId: newUuid(),
      now,
      planKey: "pro",
      subscriptionStatus: "active",
      planLimits: new Map([["ai_tokens", new Limit(100, null, new Overage(1000, 15))]]),
      grants: [{ featureKey: "limit:ai_tokens", source: "addon", enabled: true, startsAt: now, endsAt: null, limitValue: 5000 }],
      metricOverage: new Map([["ai_tokens", new Overage(1000, 20)]]),
    }).limit("ai_tokens");
    expect(limit?.value).toBe(5000); // the addon raised the cap
    expect(limit?.overage?.equals(new Overage(1000, 15))).toBe(true); // the plan still prices overage
  });
});
