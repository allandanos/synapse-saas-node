import { Injectable, Logger } from "@nestjs/common";
import { AuditWriter } from "../../core/audit";
import type { Tx } from "../../core/db/database";
import { InvalidRequestError, InvoiceNotFoundError } from "../../core/errors";
import { events } from "../../core/events";
import { OutboxWriter } from "../../core/outbox";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { SubscriptionsRepository } from "../../subscriptions/subscriptions.repository";
import { UsageRepository } from "../../usage/usage.repository";
import { assertInvoiceTransition, invoiceNumber, monthStart, periodBounds } from "./invoice-numbering";
import { type InvoiceLineDraft, type InvoiceLineRow, type InvoiceRow, InvoicesRepository } from "./invoices.repository";

export interface InvoiceWithLines {
  invoice: InvoiceRow;
  lines: InvoiceLineRow[];
}

/**
 * Framework-native invoicing: draft-from-usage → finalize → pay.
 *
 * Orgs on the manual provider (or an enterprise contract) get real invoices
 * generated here rather than only event ledgers from a payment provider.
 * Lines live in `invoice_lines`: the plan charge from the purchase-time
 * snapshot (grandfathering), metered overage priced by the ENTITLEMENT
 * RESOLVER (so addon grants shape billing exactly as they shape enforcement),
 * and the prorated corrections a mid-period plan change queued. A
 * provider-sourced invoice (webhook upsert) never gets lines — its shape is
 * the provider's, ours is ours.
 *
 * Every method runs inside the caller's transaction, so the outbox and audit
 * rows commit with the money.
 */
@Injectable()
export class InvoicingService {
  private readonly logger = new Logger(InvoicingService.name);

  constructor(
    private readonly invoices: InvoicesRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly entitlements: EntitlementsService,
    private readonly usage: UsageRepository,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditWriter,
  ) {}

  // ── Draft: build the lines from the org's plan + usage ─────────────────────

  /**
   * Create (or return the existing) draft for the period. Idempotent per
   * (org, period): re-running a billing job is safe.
   */
  async draftForOrganization(tx: Tx, organizationId: string, options: { period?: string | null } = {}): Promise<InvoiceRow> {
    const periodStart = options.period ?? monthStart();
    const existing = await this.invoices.findDraftForPeriod(tx, organizationId, periodStart);
    if (existing) return existing;

    const subscription = await this.subscriptions.currentForOrganization(tx, organizationId);
    if (!subscription) throw new InvalidRequestError("Organization has no active subscription to bill");

    const snapshot = subscription.plan_snapshot;
    const planKey = String(snapshot.key ?? "unknown");
    const planCents = Number(snapshot.price_cents ?? 0);
    const lines: InvoiceLineDraft[] = [];

    // 1 — the plan charge, at the price frozen when the plan was purchased
    if (planCents > 0) {
      lines.push({
        kind: "plan",
        description: `${String(snapshot.name ?? planKey)} plan (${String(snapshot.interval ?? "month")}ly)`,
        quantity: 1,
        unit_amount_cents: planCents,
        amount_cents: planCents,
      });
    }
    // 2 — metered overage; quantity × unit price === amount, so each line reconciles alone
    lines.push(...(await this.overageLines(tx, organizationId, periodStart)));
    // 3 — prorated adjustments queued by mid-period plan changes, drained here
    lines.push(...adjustmentLines(subscription.pending_adjustments));

    let subtotal = lines.reduce((sum, line) => sum + line.amount_cents, 0);
    let pending: Record<string, unknown>[] = [];
    if (subtotal < 0) {
      // Nothing to collect; carry the remaining credit into the next draft.
      pending = [
        {
          kind: "credit_carryover",
          amount_cents: subtotal,
          description: "Credit carried forward from the previous invoice",
          created_at: new Date().toISOString(),
        },
      ];
      subtotal = 0;
    }
    await this.subscriptions.update(tx, subscription.id, { pending_adjustments: pending });

    const bounds = periodBounds(periodStart);
    const invoice = await this.invoices.insert(tx, {
      organizationId,
      provider: "synapse",
      currency: String(snapshot.currency ?? "PHP"),
      subtotalCents: subtotal,
      totalCents: subtotal,
      status: "draft",
      periodStart: bounds.start,
      periodEnd: bounds.end,
    });
    await this.invoices.insertLines(tx, invoice.id, organizationId, lines);

    await this.audit.log(tx, {
      eventType: events.INVOICE_CREATED,
      organizationId,
      targetType: "invoice",
      targetId: invoice.id,
      diff: { period: periodStart, lines: lines.length, subtotal_cents: subtotal },
    });
    this.logger.log(`invoice drafted org=${organizationId} period=${periodStart} lines=${String(lines.length)}`);
    return invoice;
  }

  // ── Finalize: number it, open it ───────────────────────────────────────────

  /** Assign the number, lock the amounts, move to `open`; the outbox carries the email + webhook. */
  async finalize(tx: Tx, invoiceId: string, organizationId: string): Promise<InvoiceRow> {
    const current = await this.scoped(tx, invoiceId, organizationId);
    assertInvoiceTransition(current.status, "open");
    // Serialize numbering per org: two finalizes racing would otherwise count
    // the same prior invoices and collide on uq_invoices_org_number.
    await this.invoices.lockOrganization(tx, organizationId);
    const number = invoiceNumber(await this.invoices.numberedCount(tx, organizationId));
    const invoice = await this.invoices.update(tx, invoiceId, { status: "open", number, issued_at: new Date() });

    await this.outbox.append(tx, {
      eventType: events.INVOICE_CREATED,
      aggregateType: "invoice",
      aggregateId: invoice.id,
      organizationId,
      payload: { number: invoice.number, total_cents: invoice.total_cents, status: "open" },
    });
    // The delivery email rides the same outbox; the worker renders + attaches the PDF.
    await this.outbox.append(tx, {
      eventType: events.INVOICE_EMAIL,
      aggregateType: "invoice",
      aggregateId: invoice.id,
      organizationId,
      payload: { invoice_id: invoice.id, reason: "finalized" },
    });
    await this.audit.log(tx, {
      eventType: "invoice.finalized",
      organizationId,
      targetType: "invoice",
      targetId: invoice.id,
      diff: { number: invoice.number },
    });
    return invoice;
  }

  // ── Money movements (operator-only surfaces) ───────────────────────────────

  async recordPayment(tx: Tx, invoiceId: string, organizationId: string, input: { amountCents: number; reference?: string | null }): Promise<InvoiceRow> {
    const current = await this.scoped(tx, invoiceId, organizationId);
    assertInvoiceTransition(current.status, "paid");
    if (input.amountCents < current.total_cents) {
      throw new InvalidRequestError("Partial payments are not supported in v1", { expected: current.total_cents, received: input.amountCents });
    }
    const invoice = await this.invoices.update(tx, invoiceId, { status: "paid", paid_at: new Date() });

    await this.outbox.append(tx, {
      eventType: events.INVOICE_PAID,
      aggregateType: "invoice",
      aggregateId: invoice.id,
      organizationId,
      payload: { total_cents: invoice.total_cents, currency: invoice.currency, reference: input.reference ?? null },
    });
    await this.outbox.append(tx, {
      eventType: events.INVOICE_EMAIL,
      aggregateType: "invoice",
      aggregateId: invoice.id,
      organizationId,
      payload: { invoice_id: invoice.id, reason: "paid" },
    });
    await this.audit.log(tx, {
      eventType: "invoice.payment_recorded",
      organizationId,
      targetType: "invoice",
      targetId: invoice.id,
      diff: { amount_cents: input.amountCents, reference: input.reference ?? null },
    });
    return invoice;
  }

  async void(tx: Tx, invoiceId: string, organizationId: string): Promise<InvoiceRow> {
    const current = await this.scoped(tx, invoiceId, organizationId);
    assertInvoiceTransition(current.status, "void");
    const invoice = await this.invoices.update(tx, invoiceId, { status: "void" });
    await this.audit.log(tx, { eventType: "invoice.voided", organizationId, targetType: "invoice", targetId: invoice.id });
    return invoice;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  get(tx: Tx, invoiceId: string, organizationId: string): Promise<InvoiceRow> {
    return this.scoped(tx, invoiceId, organizationId);
  }

  async withLines(tx: Tx, invoice: InvoiceRow): Promise<InvoiceWithLines> {
    return { invoice, lines: await this.invoices.linesFor(tx, invoice.id) };
  }

  listForOrganization(tx: Tx, organizationId: string): Promise<InvoiceRow[]> {
    return this.invoices.listForOrganization(tx, organizationId);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async scoped(tx: Tx, invoiceId: string, organizationId: string): Promise<InvoiceRow> {
    const invoice = await this.invoices.findById(tx, invoiceId);
    if (!invoice || invoice.organization_id !== organizationId) throw new InvoiceNotFoundError("Invoice not found"); // cross-tenant 404
    return invoice;
  }

  /** One line per metric whose usage exceeded its included amount AND carries a price. */
  private async overageLines(tx: Tx, organizationId: string, period: string): Promise<InvoiceLineDraft[]> {
    const effective = await this.entitlements.effectiveForOrg(tx, organizationId);
    const lines: InvoiceLineDraft[] = [];
    for (const metric of [...effective.limits.keys()].sort()) {
      const limit = effective.limits.get(metric);
      if (!limit || limit.value === null || limit.overage === null) continue;
      const used = await this.usage.currentTotal(tx, organizationId, metric, period);
      const unitsOver = used - limit.value;
      if (unitsOver <= 0) continue;
      const [quantity, cents] = limit.overage.bill(unitsOver);
      const per = limit.overage.unit > 1 ? ` (per ${limit.overage.unit.toLocaleString("en-US")})` : "";
      lines.push({
        kind: "overage",
        description: `${metric} overage — ${unitsOver.toLocaleString("en-US")} units over plan${per}`,
        quantity,
        unit_amount_cents: limit.overage.priceCents,
        amount_cents: cents,
        metric,
        properties: { units_over: unitsOver, included: limit.value, overage_unit: limit.overage.unit },
      });
    }
    return lines;
  }
}

/** Pending proration/credit entries → invoice lines (a credit when negative). */
export function adjustmentLines(adjustments: readonly Record<string, unknown>[]): InvoiceLineDraft[] {
  const lines: InvoiceLineDraft[] = [];
  for (const adjustment of adjustments) {
    const amount = Math.trunc(Number(adjustment.amount_cents ?? 0)) || 0;
    if (amount === 0) continue;
    const properties = Object.fromEntries(Object.entries(adjustment).filter(([key]) => key !== "description" && key !== "amount_cents"));
    lines.push({
      kind: amount < 0 ? "credit" : "custom",
      description: String(adjustment.description ?? adjustment.kind ?? "adjustment"),
      quantity: 1,
      unit_amount_cents: amount,
      amount_cents: amount,
      properties,
    });
  }
  return lines;
}
