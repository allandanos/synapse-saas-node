import { describe, expect, it } from "vitest";
import { arrearsAdjustmentCents, prorate } from "../../src/subscriptions/proration";

/** Transliterated from the reference's tests/unit/subscriptions/test_proration.py — pins the arithmetic invoices depend on. */
const DAY = 86_400_000;
const START = new Date(Date.UTC(2026, 8, 1));
const END = new Date(START.getTime() + 30 * DAY);
const at = (days: number): Date => new Date(START.getTime() + days * DAY);

describe("prorate", () => {
  it("halfway splits both prices in half", () => {
    const result = prorate(10000, 30000, START, END, at(15));
    expect(result.fractionRemaining).toBe(0.5);
    expect(result.creditCents).toBe(5000);
    expect(result.chargeCents).toBe(15000);
    expect(result.netCents).toBe(10000);
  });

  it("before the period starts is the whole period", () => {
    const result = prorate(10000, 30000, START, END, at(-3));
    expect(result.fractionRemaining).toBe(1);
    expect(result.netCents).toBe(20000);
  });

  it("after the period ends is nothing", () => {
    const result = prorate(10000, 30000, START, END, new Date(END.getTime() + 1000));
    expect(result.fractionRemaining).toBe(0);
    expect([result.creditCents, result.chargeCents, result.netCents]).toEqual([0, 0, 0]);
  });

  it("zero-length period prorates nothing", () => {
    expect(prorate(10000, 30000, START, START, START).netCents).toBe(0);
  });

  it("rounds half up to whole cents", () => {
    // 1/3 of the period left: 1000 * 0.333333 = 333.333 → 333; 5 * 0.333333 → 1.67 → 2
    const result = prorate(1000, 5, START, END, at(20));
    expect(result.fractionRemaining).toBe(0.333333);
    expect(result.creditCents).toBe(333);
    expect(result.chargeCents).toBe(2);
  });

  it("downgrade nets a credit", () => {
    expect(prorate(30000, 10000, START, END, at(15)).netCents).toBe(-10000);
  });
});

describe("arrears adjustment", () => {
  it("upgrade credits the elapsed fraction", () => {
    const adjustment = arrearsAdjustmentCents(49900, 199900, START, END, at(15));
    expect(adjustment).toBe(-75000);
    expect(199900 + adjustment).toBe(49900 * 0.5 + 199900 * 0.5);
  });

  it("downgrade charges the elapsed fraction", () => {
    const adjustment = arrearsAdjustmentCents(199900, 49900, START, END, at(15));
    expect(adjustment).toBe(75000);
    expect(49900 + adjustment).toBe(199900 * 0.5 + 49900 * 0.5);
  });

  it("change at period start needs no correction; at the end is fully the old price; same price is zero", () => {
    expect(arrearsAdjustmentCents(49900, 199900, START, END, START)).toBe(0);
    expect(arrearsAdjustmentCents(49900, 199900, START, END, END)).toBe(-150000);
    expect(arrearsAdjustmentCents(49900, 49900, START, END, at(9))).toBe(0);
  });

  it("half-cent corrections round away from zero, like the reference's ROUND_HALF_UP", () => {
    // 1 cent difference over a 1/3 elapsed period: -0.333… → 0; 3 cents at 0.5 → -1.5 → -2
    expect(arrearsAdjustmentCents(0, 1, START, END, at(10))).toBe(0);
    expect(arrearsAdjustmentCents(0, 3, START, END, at(15))).toBe(-2);
    expect(arrearsAdjustmentCents(3, 0, START, END, at(15))).toBe(2);
  });
});
