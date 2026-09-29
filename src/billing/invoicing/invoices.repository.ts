import { Injectable } from "@nestjs/common";
import type { Tx } from "../../core/db/database";
import { newUuid } from "../../core/ids";

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";
export type InvoiceLineKind = "plan" | "overage" | "credit" | "custom";

export interface InvoiceRow {
  id: string;
  organization_id: string;
  billing_customer_id: string | null;
  provider: string | null;
  provider_invoice_id: string | null;
  number: string | null;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  status: InvoiceStatus;
  period_start: Date | null;
  period_end: Date | null;
  hosted_url: string | null;
  pdf_url: string | null;
  issued_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
}

export interface InvoiceLineRow {
  id: string;
  invoice_id: string;
  organization_id: string;
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  metric: string | null;
  properties: Record<string, unknown>;
}

/** A line before it has an id: `quantity × unit_amount_cents === amount_cents` always holds. */
export interface InvoiceLineDraft {
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  metric?: string | null;
  properties?: Record<string, unknown>;
}

export interface InvoicePatch {
  status?: InvoiceStatus;
  number?: string | null;
  issued_at?: Date | null;
  paid_at?: Date | null;
  billing_customer_id?: string | null;
  provider?: string | null;
  provider_invoice_id?: string | null;
  currency?: string;
  subtotal_cents?: number;
  tax_cents?: number;
  total_cents?: number;
  hosted_url?: string | null;
}

const COLUMNS =
  "id, organization_id, billing_customer_id, provider, provider_invoice_id, number, currency, subtotal_cents, tax_cents, total_cents, status, period_start, period_end, hosted_url, pdf_url, issued_at, paid_at, created_at";
const LINE_COLUMNS = "id, invoice_id, organization_id, kind, description, quantity, unit_amount_cents, amount_cents, metric, properties";

@Injectable()
export class InvoicesRepository {
  findById(tx: Tx, id: string): Promise<InvoiceRow | undefined> {
    return tx.one<InvoiceRow>(`SELECT ${COLUMNS} FROM invoices WHERE id = $1`, [id]);
  }

  /** The org that owns an invoice, regardless of tenant binding (operator routes derive scope from it). */
  async organizationOf(tx: Tx, id: string): Promise<string | undefined> {
    const row = await tx.one<{ organization_id: string }>(`SELECT organization_id FROM invoices WHERE id = $1`, [id]);
    return row?.organization_id;
  }

  listForOrganization(tx: Tx, organizationId: string, limit = 50): Promise<InvoiceRow[]> {
    return tx.rows<InvoiceRow>(`SELECT ${COLUMNS} FROM invoices WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`, [organizationId, limit]);
  }

  /** The open draft for a month, if any — what makes drafting idempotent per (org, period). */
  findDraftForPeriod(tx: Tx, organizationId: string, periodStart: string): Promise<InvoiceRow | undefined> {
    return tx.one<InvoiceRow>(
      `SELECT ${COLUMNS} FROM invoices
       WHERE organization_id = $1 AND status = 'draft' AND (period_start AT TIME ZONE 'UTC')::date = $2::date
       ORDER BY created_at LIMIT 1`,
      [organizationId, periodStart],
    );
  }

  findByProviderRef(tx: Tx, provider: string, providerInvoiceId: string): Promise<InvoiceRow | undefined> {
    return tx.one<InvoiceRow>(`SELECT ${COLUMNS} FROM invoices WHERE provider = $1 AND provider_invoice_id = $2`, [provider, providerInvoiceId]);
  }

  async insert(
    tx: Tx,
    invoice: {
      organizationId: string;
      billingCustomerId?: string | null;
      provider: string | null;
      providerInvoiceId?: string | null;
      currency: string;
      subtotalCents: number;
      taxCents?: number;
      totalCents: number;
      status: InvoiceStatus;
      periodStart: Date | null;
      periodEnd: Date | null;
      hostedUrl?: string | null;
      paidAt?: Date | null;
    },
  ): Promise<InvoiceRow> {
    const row = await tx.one<InvoiceRow>(
      `INSERT INTO invoices (id, organization_id, billing_customer_id, provider, provider_invoice_id, currency, subtotal_cents, tax_cents,
         total_cents, status, period_start, period_end, hosted_url, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${COLUMNS}`,
      [
        newUuid(),
        invoice.organizationId,
        invoice.billingCustomerId ?? null,
        invoice.provider,
        invoice.providerInvoiceId ?? null,
        invoice.currency,
        invoice.subtotalCents,
        invoice.taxCents ?? 0,
        invoice.totalCents,
        invoice.status,
        invoice.periodStart,
        invoice.periodEnd,
        invoice.hostedUrl ?? null,
        invoice.paidAt ?? null,
      ],
    );
    return row as InvoiceRow;
  }

  async update(tx: Tx, id: string, patch: InvoicePatch): Promise<InvoiceRow> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return (await this.findById(tx, id)) as InvoiceRow;
    const sets = entries.map(([column], index) => `${column} = $${String(index + 2)}`);
    const row = await tx.one<InvoiceRow>(`UPDATE invoices SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLUMNS}`, [id, ...entries.map(([, value]) => value)]);
    return row as InvoiceRow;
  }

  /** Locks the org row so two finalizes cannot count the same prior invoices and collide on the number. */
  async lockOrganization(tx: Tx, organizationId: string): Promise<void> {
    await tx.query(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [organizationId]);
  }

  /** How many invoices of this org already carry a number — the numbering sequence input. */
  async numberedCount(tx: Tx, organizationId: string): Promise<number> {
    const row = await tx.one<{ count: number }>(`SELECT count(*)::bigint AS count FROM invoices WHERE organization_id = $1 AND number IS NOT NULL`, [
      organizationId,
    ]);
    return Number(row?.count ?? 0);
  }

  linesFor(tx: Tx, invoiceId: string): Promise<InvoiceLineRow[]> {
    return tx.rows<InvoiceLineRow>(`SELECT ${LINE_COLUMNS} FROM invoice_lines WHERE invoice_id = $1 ORDER BY created_at, id`, [invoiceId]);
  }

  async insertLines(tx: Tx, invoiceId: string, organizationId: string, lines: readonly InvoiceLineDraft[]): Promise<void> {
    for (const line of lines) {
      await tx.query(
        `INSERT INTO invoice_lines (id, invoice_id, organization_id, kind, description, quantity, unit_amount_cents, amount_cents, metric, properties)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          newUuid(),
          invoiceId,
          organizationId,
          line.kind,
          line.description,
          line.quantity,
          line.unit_amount_cents,
          line.amount_cents,
          line.metric ?? null,
          JSON.stringify(line.properties ?? {}),
        ],
      );
    }
  }
}
