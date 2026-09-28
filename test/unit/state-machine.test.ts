import { describe, expect, it } from "vitest";
import { type DomainError, SubscriptionStateError } from "../../src/core/errors";
import { assertTransition, canTransition, OCCUPYING_STATUSES } from "../../src/subscriptions/state-machine";

/** Transliterated from the reference's tests/unit/subscriptions/test_state_machine.py. */
describe("subscription state machine", () => {
  it.each([
    ["incomplete", "trialing"],
    ["incomplete", "active"],
    ["trialing", "active"],
    ["trialing", "canceled"],
    ["active", "past_due"],
    ["active", "canceled"],
    ["active", "unpaid"],
    ["past_due", "active"], // payment recovered
    ["past_due", "canceled"],
    ["unpaid", "canceled"],
    ["canceled", "active"], // resume
  ])("%s → %s is legal", (current, target) => {
    expect(canTransition(current, target)).toBe(true);
  });

  it.each([
    ["canceled", "trialing"], // cannot re-trial a dead subscription
    ["canceled", "past_due"],
    ["unpaid", "trialing"],
    ["incomplete", "unpaid"],
  ])("%s → %s is illegal", (current, target) => {
    expect(canTransition(current, target)).toBe(false);
  });

  it("same state is idempotent", () => {
    for (const status of ["trialing", "active", "past_due", "canceled"]) expect(canTransition(status, status)).toBe(true);
    expect(() => assertTransition("active", "active")).not.toThrow();
  });

  it("assert raises with context", () => {
    try {
      assertTransition("canceled", "trialing");
      throw new Error("expected SubscriptionStateError");
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionStateError);
      const extras = (error as DomainError).extras;
      expect(extras.from).toBe("canceled");
      expect(extras.allowed).toEqual(["active"]);
      expect((error as DomainError).status).toBe(409);
      expect((error as DomainError).title).toBe("invalid_subscription_transition");
    }
  });

  it("occupying statuses", () => {
    expect(OCCUPYING_STATUSES).toEqual(new Set(["trialing", "active", "past_due"]));
  });
});
