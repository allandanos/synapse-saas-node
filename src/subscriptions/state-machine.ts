import { SubscriptionStateError } from "../core/errors";

/**
 * Subscription status state machine (transliterated from the reference).
 * Provider webhooks arrive out of order and get replayed; transitions must be
 * idempotent and monotonic. This table is the single definition of legality.
 */

// status → set of statuses it may move to
export const ALLOWED_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  incomplete: new Set(["trialing", "active", "past_due", "canceled"]),
  trialing: new Set(["active", "past_due", "canceled", "incomplete"]),
  active: new Set(["past_due", "canceled", "unpaid", "active"]), // active→active = plan change
  past_due: new Set(["active", "canceled", "unpaid"]),
  unpaid: new Set(["active", "canceled"]),
  canceled: new Set(["active"]), // resume
};

/** Statuses whose plan features are in effect (the entitlement resolver uses this). */
export const OCCUPYING_STATUSES: ReadonlySet<string> = new Set(["trialing", "active", "past_due"]);

export function canTransition(current: string, target: string): boolean {
  if (current === target) return true; // idempotent re-assertion (webhook replays)
  return ALLOWED_TRANSITIONS[current]?.has(target) ?? false;
}

export function assertTransition(current: string, target: string): void {
  if (canTransition(current, target)) return;
  const allowed = [...(ALLOWED_TRANSITIONS[current] ?? [])].sort();
  throw new SubscriptionStateError(`Cannot transition subscription from '${current}' to '${target}'`, { from: current, to: target, allowed });
}
