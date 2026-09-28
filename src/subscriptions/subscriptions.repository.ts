import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";
import { OCCUPYING_STATUSES } from "./state-machine";

export interface SubscriptionRow {
  id: string;
  organization_id: string;
  plan_id: string;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  trial_ends_at: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  provider: string | null;
  provider_subscription_id: string | null;
  billing_customer_id: string | null;
  plan_snapshot: Record<string, unknown>;
  pending_adjustments: Record<string, unknown>[];
  created_at: Date;
}

export interface SubscriptionPatch {
  status?: string;
  plan_id?: string;
  plan_snapshot?: Record<string, unknown>;
  current_period_start?: Date;
  current_period_end?: Date;
  trial_ends_at?: Date | null;
  cancel_at_period_end?: boolean;
  canceled_at?: Date | null;
  provider?: string | null;
  provider_subscription_id?: string | null;
  pending_adjustments?: Record<string, unknown>[];
}

const COLUMNS =
  "id, organization_id, plan_id, status, current_period_start, current_period_end, trial_ends_at, cancel_at_period_end, canceled_at, provider, provider_subscription_id, billing_customer_id, plan_snapshot, pending_adjustments, created_at";

const JSON_COLUMNS = new Set(["plan_snapshot", "pending_adjustments"]);

@Injectable()
export class SubscriptionsRepository {
  /** The occupying subscription (trialing/active/past_due), if any. */
  currentForOrganization(tx: Tx, organizationId: string): Promise<SubscriptionRow | undefined> {
    return tx.one<SubscriptionRow>(
      `SELECT ${COLUMNS} FROM subscriptions WHERE organization_id = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC, id DESC LIMIT 1`,
      [organizationId, [...OCCUPYING_STATUSES]],
    );
  }

  findById(tx: Tx, id: string): Promise<SubscriptionRow | undefined> {
    return tx.one<SubscriptionRow>(`SELECT ${COLUMNS} FROM subscriptions WHERE id = $1`, [id]);
  }

  async insert(
    tx: Tx,
    s: {
      organizationId: string;
      planId: string;
      status: string;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      trialEndsAt: Date | null;
      provider: string | null;
      providerSubscriptionId: string | null;
      billingCustomerId: string | null;
      planSnapshot: Record<string, unknown>;
    },
  ): Promise<SubscriptionRow> {
    const row = await tx.one<SubscriptionRow>(
      `INSERT INTO subscriptions (id, organization_id, plan_id, status, current_period_start, current_period_end, trial_ends_at, cancel_at_period_end,
         canceled_at, provider, provider_subscription_id, billing_customer_id, plan_snapshot, pending_adjustments, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, NULL, $8, $9, $10, $11::jsonb, '[]'::jsonb, '{}'::jsonb)
       RETURNING ${COLUMNS}`,
      [newUuid(), s.organizationId, s.planId, s.status, s.currentPeriodStart, s.currentPeriodEnd, s.trialEndsAt, s.provider, s.providerSubscriptionId, s.billingCustomerId, JSON.stringify(s.planSnapshot)],
    );
    return row as SubscriptionRow;
  }

  async update(tx: Tx, id: string, patch: SubscriptionPatch): Promise<SubscriptionRow> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return (await this.findById(tx, id)) as SubscriptionRow;
    const sets = entries.map(([column], i) => (JSON_COLUMNS.has(column) ? `${column} = $${i + 2}::jsonb` : `${column} = $${i + 2}`));
    const params = entries.map(([column, value]) => (JSON_COLUMNS.has(column) ? JSON.stringify(value) : value));
    const row = await tx.one<SubscriptionRow>(`UPDATE subscriptions SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [
      id,
      ...params,
    ]);
    return row as SubscriptionRow;
  }
}
