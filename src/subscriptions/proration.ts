/**
 * Proration for mid-period plan changes — a pure function (transliterated
 * from the reference's `subscriptions/proration.py`). Time-based, second-granular.
 *
 * - `prorate()` — in advance: the unused fraction of the period is credited at
 *   the old price and charged at the new one (`netCents`).
 * - `arrearsAdjustmentCents()` — in arrears, which is how the invoicing engine
 *   bills: the elapsed fraction at the price difference.
 *
 * The fraction is kept as an integer number of millionths (the reference
 * quantises its Decimal to 6 places, half-even) and cents round half away
 * from zero like Python's ROUND_HALF_UP. No floating point in the money path.
 */

const MICRO = 1_000_000n;

export interface Proration {
  /** Unused portion of the old plan, refunded. */
  readonly creditCents: number;
  /** The same portion at the new price. */
  readonly chargeCents: number;
  /** 0..1 of the period left at `now` (6 decimal places). */
  readonly fractionRemaining: number;
  /** In-advance view: positive ⇒ the org owes this much now; negative ⇒ it is owed. */
  readonly netCents: number;
  readonly elapsedFraction: number;
}

/** Integer division rounding half to even (Python's Decimal default). */
function divHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice < denominator) return quotient;
  if (twice > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** Integer division rounding half away from zero (ROUND_HALF_UP). */
function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = abs / denominator;
  const rounded = (abs % denominator) * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function centsAt(amount: number, fractionMicros: bigint): number {
  return Number(divHalfUp(BigInt(amount) * fractionMicros, MICRO));
}

/** Millionths of the period remaining at `now`, clamped to [0, 1]. */
function fractionRemainingMicros(periodStart: Date, periodEnd: Date, now: Date): bigint | null {
  const total = BigInt(periodEnd.getTime() - periodStart.getTime());
  if (total <= 0n) return null;
  let remaining = BigInt(periodEnd.getTime() - now.getTime());
  if (remaining < 0n) remaining = 0n;
  if (remaining > total) remaining = total;
  return divHalfEven(remaining * MICRO, total);
}

/**
 * Prorate a plan change at `now` inside [periodStart, periodEnd).
 * Clamped: before the period starts ⇒ the whole period; after it ends ⇒ nothing.
 * A zero-length period prorates nothing (the renewal charges in full).
 */
export function prorate(oldCents: number, newCents: number, periodStart: Date, periodEnd: Date, now: Date): Proration {
  const micros = fractionRemainingMicros(periodStart, periodEnd, now);
  if (micros === null) return { creditCents: 0, chargeCents: 0, fractionRemaining: 0, netCents: 0, elapsedFraction: 1 };
  const creditCents = centsAt(oldCents, micros);
  const chargeCents = centsAt(newCents, micros);
  const fractionRemaining = Number(micros) / 1_000_000;
  return {
    creditCents,
    chargeCents,
    fractionRemaining,
    netCents: chargeCents - creditCents,
    elapsedFraction: Number(MICRO - micros) / 1_000_000,
  };
}

/**
 * Correction line for a period invoiced IN ARREARS at the new price: the
 * elapsed fraction at the price difference — negative (credit) on an upgrade,
 * positive on a downgrade — so that `new_price + adjustment == old*elapsed + new*remaining`.
 */
export function arrearsAdjustmentCents(oldCents: number, newCents: number, periodStart: Date, periodEnd: Date, now: Date): number {
  const micros = fractionRemainingMicros(periodStart, periodEnd, now);
  const elapsedMicros = micros === null ? MICRO : MICRO - micros;
  return centsAt(oldCents - newCents, elapsedMicros);
}
