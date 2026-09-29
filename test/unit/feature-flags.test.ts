import { describe, expect, it } from "vitest";
import { BUCKETS, bucketOf, inRollout } from "../../src/feature-flags/buckets";

/**
 * Buckets computed by the reference's `bucket_of` (sha256 of
 * "{flag}:{identifier}", first four bytes big-endian, modulo 10 000). A
 * divergence here means an org inside a 50% rollout on the Python server
 * would fall outside it on this one — a contract break, not a test detail.
 */
const REFERENCE_BUCKETS = [
  { flag: "new-editor", identifier: "11111111-1111-1111-1111-111111111111", bucket: 2892 },
  { flag: "new-editor", identifier: "22222222-2222-2222-2222-222222222222", bucket: 460 },
  { flag: "beta.search", identifier: "anonymous", bucket: 9328 },
  { flag: "kill-switch", identifier: "org-42", bucket: 2181 },
  { flag: "a-b_c.d", identifier: "user-7", bucket: 9939 },
];

describe("feature flag bucketing", () => {
  it("matches the reference bucket for every vector", () => {
    for (const { flag, identifier, bucket } of REFERENCE_BUCKETS) {
      expect(bucketOf(flag, identifier), `${flag}:${identifier}`).toBe(bucket);
    }
  });

  it("is deterministic and bounded", () => {
    for (let i = 0; i < 500; i += 1) {
      const bucket = bucketOf("flag", `id-${String(i)}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKETS);
      expect(bucketOf("flag", `id-${String(i)}`)).toBe(bucket);
    }
  });

  it("changes the bucket when the flag key changes", () => {
    expect(bucketOf("flag-a", "same-id")).not.toBe(bucketOf("flag-b", "same-id"));
  });
});

describe("rollout membership", () => {
  it("is nobody at 0% and everybody at 100%", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(inRollout("flag", `id-${String(i)}`, 0)).toBe(false);
      expect(inRollout("flag", `id-${String(i)}`, 100)).toBe(true);
    }
  });

  it("uses floor division on the bucket ceiling, like the reference", () => {
    // 2892 is the bucket of this identifier: in at 29%, out at 28%.
    const identifier = "11111111-1111-1111-1111-111111111111";
    expect(inRollout("new-editor", identifier, 29)).toBe(true);
    expect(inRollout("new-editor", identifier, 28)).toBe(false);
  });

  it("is monotonic — raising the percentage never drops anyone out", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `id-${String(i)}`);
    for (const id of ids) {
      let wasIn = false;
      for (let pct = 0; pct <= 100; pct += 5) {
        const now = inRollout("ramp", id, pct);
        if (wasIn) expect(now).toBe(true);
        wasIn = now;
      }
    }
  });

  it("spreads roughly evenly — a 50% rollout lands near half the population", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `org-${String(i)}`);
    const inside = ids.filter((id) => inRollout("spread", id, 50)).length;
    expect(inside / ids.length).toBeGreaterThan(0.45);
    expect(inside / ids.length).toBeLessThan(0.55);
  });
});
