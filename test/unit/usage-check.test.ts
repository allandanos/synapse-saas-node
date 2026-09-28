import { describe, expect, it } from "vitest";
import { newUuid } from "../../src/core/ids";
import { EffectiveEntitlements, Limit } from "../../src/entitlements/resolver";
import { monthBucket } from "../../src/usage/usage.repository";
import { UsageService } from "../../src/usage/usage.service";

/** `UsageService.check_against` — pure limit arithmetic for an already-resolved entitlement set (`UsageCheckOut`). */
function entitlements(limits: [string, Limit][]): EffectiveEntitlements {
  return new EffectiveEntitlements(newUuid(), "free", "active", new Set(), new Map(limits));
}

describe("UsageService.checkAgainst", () => {
  const e = entitlements([
    ["api_requests", new Limit(10_000, 0.8)],
    ["projects", new Limit(2, null)],
    ["storage_bytes", new Limit(null, 0.8)],
  ]);

  it("reports used/limit/remaining and the soft threshold", () => {
    expect(UsageService.checkAgainst(e, "api_requests", 7_999)).toEqual({
      metric: "api_requests",
      used: 7_999,
      limit: 10_000,
      remaining: 2_001,
      within_limit: true,
      soft_limit: 8_000,
      soft_limit_breached: false,
    });
    expect(UsageService.checkAgainst(e, "api_requests", 8_000)).toMatchObject({ soft_limit_breached: true, within_limit: true });
  });

  it("within_limit accounts for the quantity about to be consumed (inclusive at the cap)", () => {
    expect(UsageService.checkAgainst(e, "api_requests", 9_999, 1).within_limit).toBe(true);
    expect(UsageService.checkAgainst(e, "api_requests", 9_999, 2).within_limit).toBe(false);
    expect(UsageService.checkAgainst(e, "api_requests", 10_000).within_limit).toBe(false);
  });

  it("no soft ratio ⇒ no soft limit; unlimited ⇒ null limit and never breached", () => {
    expect(UsageService.checkAgainst(e, "projects", 2)).toMatchObject({ limit: 2, remaining: 0, within_limit: false, soft_limit: null, soft_limit_breached: false });
    expect(UsageService.checkAgainst(e, "storage_bytes", 10 ** 12)).toEqual({
      metric: "storage_bytes",
      used: 10 ** 12,
      limit: null,
      remaining: null,
      within_limit: true,
      soft_limit: null,
      soft_limit_breached: false,
    });
  });

  it("an unknown metric is unlimited", () => {
    expect(UsageService.checkAgainst(e, "ai_tokens", 5)).toMatchObject({ limit: null, remaining: null, within_limit: true });
  });

  it("month buckets are UTC first-of-month dates", () => {
    expect(monthBucket(new Date(Date.UTC(2026, 8, 30, 23, 59))).toString()).toBe("2026-09-01");
    expect(monthBucket(new Date(Date.UTC(2026, 11, 1, 0, 0))).toString()).toBe("2026-12-01");
  });
});
