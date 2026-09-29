import { createHash } from "node:crypto";

/**
 * Deterministic percentage rollouts.
 *
 * Bucketing hashes stable identifiers — never randomness at read time — so the
 * same (flag, org/user) resolves the same way within a request, across
 * requests, and across implementations. The exact byte slice is part of the
 * contract: an org bucketed into a rollout by the Python reference must be in
 * the same rollout here.
 */
export const BUCKETS = 10_000;

/** Bucket `0..BUCKETS-1` from the first four bytes of `sha256("{flag}:{identifier}")`, big-endian. */
export function bucketOf(flagKey: string, identifier: string): number {
  const digest = createHash("sha256").update(`${flagKey}:${identifier}`, "utf8").digest();
  return digest.readUInt32BE(0) % BUCKETS;
}

/** True when `identifier` falls inside the first `percentage`% of buckets (floor division, like the reference). */
export function inRollout(flagKey: string, identifier: string, percentage: number): boolean {
  return bucketOf(flagKey, identifier) < Math.floor((BUCKETS * percentage) / 100);
}
