import { InvalidRequestError } from "../../core/errors";
import type { InvoiceStatus } from "./invoices.repository";

/**
 * The invoice state machine. `draft → open` is finalization, `open → paid` a
 * recorded payment; `paid`, `void` and `uncollectible` are terminal.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, ReadonlySet<InvoiceStatus>>> = {
  draft: new Set<InvoiceStatus>(["open", "void"]),
  open: new Set<InvoiceStatus>(["paid", "void", "uncollectible"]),
  paid: new Set<InvoiceStatus>(),
  void: new Set<InvoiceStatus>(),
  uncollectible: new Set<InvoiceStatus>(),
};

/** 422 `validation_failed` with `from`/`to`/`allowed` — the same shape the reference emits. */
export function assertInvoiceTransition(current: InvoiceStatus, target: InvoiceStatus): void {
  if (current === target) return;
  const allowed = INVOICE_TRANSITIONS[current] ?? new Set<InvoiceStatus>();
  if (allowed.has(target)) return;
  throw new InvalidRequestError(`Cannot move invoice from '${current}' to '${target}'`, {
    from: current,
    to: target,
    allowed: [...allowed].sort(),
  });
}

/**
 * `INV-YYYYMM-####`, scoped per org (prior finals + 1). Not a gapless legal
 * sequence — that is a jurisdiction concern — but unique, sortable and auditable.
 */
export function invoiceNumber(priorNumberedCount: number, now = new Date()): string {
  const stamp = `${String(now.getUTCFullYear())}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `INV-${stamp}-${String(priorNumberedCount + 1).padStart(4, "0")}`;
}

/** First day of the UTC month holding `now`, as a `YYYY-MM-01` date literal. */
export function monthStart(now = new Date()): string {
  return `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** `YYYY-MM-01` → the UTC instants the invoice records as its billing period. */
export function periodBounds(periodStart: string): { start: Date; end: Date } {
  const [year, month] = periodStart.split("-").map((part) => Number.parseInt(part, 10)) as [number, number, number];
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  // Last day of the month at 23:59:59 UTC (the first of the next month, minus a day).
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0) - 86_400_000);
  end.setUTCHours(23, 59, 59, 0);
  return { start, end };
}
