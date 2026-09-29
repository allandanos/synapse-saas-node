import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS, type Settings } from "../../core/config";
import type { Tx } from "../../core/db/database";
import { OCCUPYING_STATUSES } from "../../subscriptions/state-machine";

export interface SpendSummary {
  organization_id: string;
  billed_cents: number;
  paid_cents: number;
  outstanding_cents: number;
  void_cents: number;
  by_status: Record<string, number>;
  currency: string;
}

export interface MonthlySpend {
  month: string;
  total_cents: number;
  invoices: number;
}

export interface RevenueSummary {
  mrr_proxy_cents: number;
  collected_cents: number;
  outstanding_cents: number;
  paying_organizations: number;
  invoices_by_status: Record<string, number>;
  as_of: string;
}

export interface MonthlyRevenue {
  month: string;
  collected_cents: number;
  invoices: number;
}

/** `plan_snapshot->>'price_cents'` as a number — the snapshot is the purchase-time truth. */
const SNAPSHOT_PRICE = "COALESCE(plan_snapshot ->> 'price_cents', '0')::bigint";

/**
 * Read-model reporting over invoices and subscriptions. Tenant-facing: this
 * org's spend position. Platform-facing: the revenue view. Pure queries — no
 * mutations, safe to hit freely.
 */
@Injectable()
export class ReportingService {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  // ── Tenant: what has this org been billed? ────────────────────────────────

  /** Lifetime billing position for one org, split by invoice status. */
  async orgSpendSummary(tx: Tx, organizationId: string): Promise<SpendSummary> {
    const rows = await tx.rows<{ status: string; total: number }>(
      `SELECT status, COALESCE(sum(total_cents), 0)::bigint AS total FROM invoices WHERE organization_id = $1 GROUP BY status`,
      [organizationId],
    );
    const byStatus: Record<string, number> = {};
    for (const row of rows) byStatus[row.status] = Number(row.total);
    return {
      organization_id: organizationId,
      billed_cents: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      paid_cents: byStatus.paid ?? 0,
      outstanding_cents: byStatus.open ?? 0,
      void_cents: byStatus.void ?? 0,
      by_status: byStatus,
      currency: this.settings.SYNAPSE_BILLING_CURRENCY,
    };
  }

  /** Billed totals per month (`issued_at` bucket), oldest → newest. */
  async orgMonthlySpend(tx: Tx, organizationId: string): Promise<MonthlySpend[]> {
    const rows = await tx.rows<{ month: string; total_cents: number; invoice_count: number }>(
      `SELECT to_char(date_trunc('month', issued_at), 'YYYY-MM') AS month,
              sum(total_cents)::bigint AS total_cents,
              count(*)::bigint AS invoice_count
       FROM invoices
       WHERE organization_id = $1 AND status IN ('paid', 'open') AND issued_at IS NOT NULL
       GROUP BY month
       ORDER BY min(issued_at)`,
      [organizationId],
    );
    return rows.map((row) => ({ month: row.month, total_cents: Number(row.total_cents), invoices: Number(row.invoice_count) }));
  }

  // ── Platform: the revenue view ───────────────────────────────────────────

  /**
   * MRR proxy: the sum of occupying subscriptions' snapshot prices. An honest
   * label — it ignores proration and coupons — but the right first number.
   */
  async revenueSummary(tx: Tx): Promise<RevenueSummary> {
    const statuses = [...OCCUPYING_STATUSES];
    const mrr = await tx.one<{ total: number }>(
      `SELECT COALESCE(sum(${SNAPSHOT_PRICE}), 0)::bigint AS total FROM subscriptions WHERE status = ANY($1::text[])`,
      [statuses],
    );
    const collected = await tx.one<{ total: number }>(`SELECT COALESCE(sum(total_cents), 0)::bigint AS total FROM invoices WHERE status = 'paid'`);
    const outstanding = await tx.one<{ total: number }>(`SELECT COALESCE(sum(total_cents), 0)::bigint AS total FROM invoices WHERE status = 'open'`);
    const mix = await tx.rows<{ status: string; count: number }>(`SELECT status, count(*)::bigint AS count FROM invoices GROUP BY status`);
    const paying = await tx.one<{ count: number }>(
      `SELECT count(DISTINCT organization_id)::bigint AS count FROM subscriptions WHERE status = ANY($1::text[]) AND ${SNAPSHOT_PRICE} > 0`,
      [statuses],
    );
    const invoicesByStatus: Record<string, number> = {};
    for (const row of mix) invoicesByStatus[row.status] = Number(row.count);
    return {
      mrr_proxy_cents: Number(mrr?.total ?? 0),
      collected_cents: Number(collected?.total ?? 0),
      outstanding_cents: Number(outstanding?.total ?? 0),
      paying_organizations: Number(paying?.count ?? 0),
      invoices_by_status: invoicesByStatus,
      as_of: new Date().toISOString(),
    };
  }

  /** Collected (paid) revenue per month across every org. */
  async monthlyRevenue(tx: Tx): Promise<MonthlyRevenue[]> {
    const rows = await tx.rows<{ month: string; collected_cents: number; invoice_count: number }>(
      `SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') AS month,
              sum(total_cents)::bigint AS collected_cents,
              count(*)::bigint AS invoice_count
       FROM invoices
       WHERE status = 'paid' AND paid_at IS NOT NULL
       GROUP BY month
       ORDER BY min(paid_at)`,
    );
    return rows.map((row) => ({ month: row.month, collected_cents: Number(row.collected_cents), invoices: Number(row.invoice_count) }));
  }
}
