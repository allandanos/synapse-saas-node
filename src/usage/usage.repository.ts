import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { uuidV7 } from "../core/ids";

/** Gauges live in one fixed period bucket: a level has no month to reset with. */
export const GAUGE_PERIOD = "1970-01-01";

/** UTC month bucket as a `date` literal, e.g. `2026-09-01`. */
export function monthBucket(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export interface IdempotencyReplay {
  metric: string;
  quantity: number;
  total_after: number | null;
}

@Injectable()
export class UsageRepository {
  async currentTotal(tx: Tx, organizationId: string, metric: string, period: string): Promise<number> {
    const row = await tx.one<{ total: number | null }>(
      `SELECT sum(quantity_total)::bigint AS total FROM usage_counters WHERE organization_id = $1 AND metric = $2 AND period_start = $3::date`,
      [organizationId, metric, period],
    );
    return Number(row?.total ?? 0);
  }

  /** Counter rows for the month plus every gauge (which lives in the fixed bucket). */
  summaryRows(tx: Tx, organizationId: string, period: string): Promise<{ metric: string; used: number }[]> {
    return tx.rows<{ metric: string; used: number }>(
      `SELECT metric, quantity_total::bigint AS used FROM usage_counters
       WHERE organization_id = $1 AND (period_start = $2::date OR period_start = $3::date) ORDER BY metric`,
      [organizationId, period, GAUGE_PERIOD],
    );
  }

  /** True ⇒ first sight of this key (the caller proceeds); false ⇒ replay. A concurrent retry blocks on the row until the first commits. */
  async reserveIdempotency(tx: Tx, organizationId: string, key: string, metric: string, quantity: number): Promise<boolean> {
    const row = await tx.one<{ reserved: number }>(
      `INSERT INTO usage_idempotency_keys (organization_id, idempotency_key, metric, quantity) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING 1 AS reserved`,
      [organizationId, key, metric, quantity],
    );
    return row !== undefined;
  }

  async settleIdempotency(tx: Tx, organizationId: string, key: string, eventId: string, total: number): Promise<void> {
    await tx.query(`UPDATE usage_idempotency_keys SET event_id = $3, total_after = $4 WHERE organization_id = $1 AND idempotency_key = $2`, [
      organizationId,
      key,
      eventId,
      total,
    ]);
  }

  async replayIdempotent(tx: Tx, organizationId: string, key: string): Promise<IdempotencyReplay> {
    const row = await tx.one<IdempotencyReplay>(
      `SELECT metric, quantity, total_after FROM usage_idempotency_keys WHERE organization_id = $1 AND idempotency_key = $2`,
      [organizationId, key],
    );
    if (!row) throw new Error(`idempotency key ${key} vanished mid-transaction`);
    return row;
  }

  async insertEvent(
    tx: Tx,
    e: { organizationId: string; metric: string; quantity: number; occurredAt: Date; idempotencyKey: string | null; properties: Record<string, unknown> },
  ): Promise<string> {
    const id = uuidV7();
    await tx.query(
      `INSERT INTO usage_events (id, organization_id, metric, quantity, occurred_at, idempotency_key, properties) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [id, e.organizationId, e.metric, e.quantity, e.occurredAt, e.idempotencyKey, JSON.stringify(e.properties)],
    );
    return id;
  }

  /** Atomic upsert-increment under the counter's row lock; returns the new total. */
  async incrementCounter(tx: Tx, organizationId: string, metric: string, period: string, quantity: number, occurredAt: Date): Promise<number> {
    const row = await tx.one<{ quantity_total: number }>(
      `INSERT INTO usage_counters (organization_id, metric, period_start, quantity_total, last_event_at) VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT (organization_id, metric, period_start)
       DO UPDATE SET quantity_total = usage_counters.quantity_total + EXCLUDED.quantity_total, last_event_at = EXCLUDED.last_event_at, updated_at = now()
       RETURNING quantity_total`,
      [organizationId, metric, period, quantity, occurredAt],
    );
    return Number(row?.quantity_total ?? 0);
  }

  async setGauge(tx: Tx, organizationId: string, metric: string, level: number): Promise<void> {
    await tx.query(
      `INSERT INTO usage_counters (organization_id, metric, period_start, quantity_total, last_event_at) VALUES ($1, $2, $3::date, $4, now())
       ON CONFLICT (organization_id, metric, period_start)
       DO UPDATE SET quantity_total = EXCLUDED.quantity_total, last_event_at = now(), updated_at = now()`,
      [organizationId, metric, GAUGE_PERIOD, level],
    );
  }

  /** Move a gauge by `delta`, never below zero; returns the new level. */
  async adjustGauge(tx: Tx, organizationId: string, metric: string, delta: number): Promise<number> {
    const row = await tx.one<{ quantity_total: number }>(
      `INSERT INTO usage_counters (organization_id, metric, period_start, quantity_total, last_event_at) VALUES ($1, $2, $3::date, GREATEST($4::bigint, 0), now())
       ON CONFLICT (organization_id, metric, period_start)
       DO UPDATE SET quantity_total = GREATEST(usage_counters.quantity_total + $4::bigint, 0), last_event_at = now(), updated_at = now()
       RETURNING quantity_total`,
      [organizationId, metric, GAUGE_PERIOD, delta],
    );
    return Number(row?.quantity_total ?? 0);
  }

  /** Claim the once-per-period soft-limit notification; true when this call won it. */
  async markSoftLimitNotified(tx: Tx, organizationId: string, metric: string, period: string): Promise<boolean> {
    const row = await tx.one<{ claimed: number }>(
      `UPDATE usage_counters SET soft_limit_notified_at = now()
       WHERE organization_id = $1 AND metric = $2 AND period_start = $3::date AND soft_limit_notified_at IS NULL RETURNING 1 AS claimed`,
      [organizationId, metric, period],
    );
    return row !== undefined;
  }
}
