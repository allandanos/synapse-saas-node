import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

/** Rows of the catalog projection: `features`, `metrics`, `plans` (+ `plan_features`, `plan_limits`). */

export interface FeatureRow {
  key: string;
  name: string;
  description: string | null;
  category: string | null;
}

export interface MetricRow {
  key: string;
  name: string;
  kind: "counter" | "gauge";
  unit: string | null;
  overage_unit: number | null;
  overage_price_cents: number | null;
}

export interface PlanFeatureRow {
  feature_key: string;
  enabled: boolean;
}

export interface PlanLimitRow {
  metric: string;
  limit_value: number | null;
  /** numeric(5,2) — parsed to a float, null when unset. */
  soft_limit_ratio: number | null;
  overage_unit: number | null;
  overage_price_cents: number | null;
}

export interface PlanRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  price_cents: number | null;
  currency: string;
  interval: string | null;
  is_public: boolean;
  is_custom: boolean;
  trial_days: number;
  sort_order: number;
  archived_at: Date | null;
}

/** A plan with its features and limits loaded — snapshots and responses need them. */
export interface PlanWithDetails extends PlanRow {
  features: PlanFeatureRow[];
  limits: PlanLimitRow[];
}

export interface PlanRead {
  id: string;
  key: string;
  name: string;
  description: string | null;
  price_cents: number | null;
  currency: string;
  interval: string | null;
  is_public: boolean;
  is_custom: boolean;
  trial_days: number;
  sort_order: number;
  features: PlanFeatureRow[];
  limits: { metric: string; limit_value: number | null; soft_limit_ratio: number | null }[];
}

export function toPlanRead(plan: PlanWithDetails): PlanRead {
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    price_cents: plan.price_cents,
    currency: plan.currency,
    interval: plan.interval,
    is_public: plan.is_public,
    is_custom: plan.is_custom,
    trial_days: plan.trial_days,
    sort_order: plan.sort_order,
    features: plan.features.map((f) => ({ feature_key: f.feature_key, enabled: f.enabled })),
    limits: plan.limits.map((l) => ({ metric: l.metric, limit_value: l.limit_value, soft_limit_ratio: l.soft_limit_ratio })),
  };
}

export interface PlanValues {
  name: string;
  description: string | null;
  price_cents: number | null;
  currency: string;
  interval: string | null;
  is_public: boolean;
  is_custom: boolean;
  trial_days: number;
  sort_order: number;
  archived_at: Date | null;
}

export interface PlanLimitValues {
  limit_value: number | null;
  soft_limit_ratio: number | null;
  overage_unit: number | null;
  overage_price_cents: number | null;
}

const PLAN_COLUMNS = "id, key, name, description, price_cents, currency, interval, is_public, is_custom, trial_days, sort_order, archived_at";

const ratio = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

@Injectable()
export class PlansRepository {
  // ── Catalog reads ───────────────────────────────────────────────────────────

  async findByKey(tx: Tx, key: string, options: { includeArchived?: boolean } = {}): Promise<PlanWithDetails | undefined> {
    const row = await tx.one<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE key = $1 ${options.includeArchived ? "" : "AND archived_at IS NULL"}`,
      [key],
    );
    return row ? this.withDetails(tx, row) : undefined;
  }

  async findById(tx: Tx, id: string): Promise<PlanWithDetails | undefined> {
    const row = await tx.one<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1`, [id]);
    return row ? this.withDetails(tx, row) : undefined;
  }

  /** Public, un-archived plans in `sort_order` — the `/v1/plans` page. */
  async listPublic(tx: Tx, limit: number, offset: number): Promise<{ plans: PlanWithDetails[]; total: number }> {
    const rows = await tx.rows<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE is_public = true AND archived_at IS NULL ORDER BY sort_order, key LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const count = await tx.one<{ count: number }>(`SELECT count(*)::int AS count FROM plans WHERE is_public = true AND archived_at IS NULL`);
    return { plans: await Promise.all(rows.map((row) => this.withDetails(tx, row))), total: count?.count ?? 0 };
  }

  /** Keys of the plans (any visibility) that carry `feature`, sorted. */
  async plansWithFeature(tx: Tx, feature: string): Promise<string[]> {
    const rows = await tx.rows<{ key: string }>(
      `SELECT DISTINCT p.key FROM plans p JOIN plan_features pf ON pf.plan_id = p.id WHERE pf.feature_key = $1 AND pf.enabled = true ORDER BY p.key`,
      [feature],
    );
    return rows.map((r) => r.key);
  }

  async withDetails(tx: Tx, plan: PlanRow): Promise<PlanWithDetails> {
    const features = await this.planFeatures(tx, plan.id);
    const limits = await this.planLimits(tx, plan.id);
    return { ...plan, features, limits };
  }

  planFeatures(tx: Tx, planId: string): Promise<PlanFeatureRow[]> {
    return tx.rows<PlanFeatureRow>(`SELECT feature_key, enabled FROM plan_features WHERE plan_id = $1 ORDER BY feature_key`, [planId]);
  }

  async planLimits(tx: Tx, planId: string): Promise<PlanLimitRow[]> {
    const rows = await tx.rows<PlanLimitRow>(
      `SELECT metric, limit_value, soft_limit_ratio, overage_unit, overage_price_cents FROM plan_limits WHERE plan_id = $1 ORDER BY metric`,
      [planId],
    );
    return rows.map((row) => ({ ...row, soft_limit_ratio: ratio(row.soft_limit_ratio) }));
  }

  findMetric(tx: Tx, key: string): Promise<MetricRow | undefined> {
    return tx.one<MetricRow>(`SELECT key, name, kind, unit, overage_unit, overage_price_cents FROM metrics WHERE key = $1`, [key]);
  }

  /** Metrics carrying a default overage price (the resolver's fallback for add-on limits). */
  metricsWithOverage(tx: Tx): Promise<MetricRow[]> {
    return tx.rows<MetricRow>(
      `SELECT key, name, kind, unit, overage_unit, overage_price_cents FROM metrics WHERE overage_price_cents IS NOT NULL ORDER BY key`,
    );
  }

  // ── Sync writes (catalog-sync.ts) ───────────────────────────────────────────

  async allFeatureKeys(tx: Tx): Promise<Set<string>> {
    return new Set((await tx.rows<{ key: string }>(`SELECT key FROM features`)).map((r) => r.key));
  }

  async insertFeature(tx: Tx, feature: { key: string; name: string; category: string | null }): Promise<void> {
    await tx.query(`INSERT INTO features (key, name, category) VALUES ($1, $2, $3)`, [feature.key, feature.name, feature.category]);
  }

  async allMetricKeys(tx: Tx): Promise<Set<string>> {
    return new Set((await tx.rows<{ key: string }>(`SELECT key FROM metrics`)).map((r) => r.key));
  }

  async upsertMetric(tx: Tx, metric: Omit<MetricRow, "overage_unit" | "overage_price_cents"> & { overage_unit: number | null; overage_price_cents: number | null }): Promise<void> {
    await tx.query(
      `INSERT INTO metrics (key, name, kind, unit, overage_unit, overage_price_cents) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, unit = EXCLUDED.unit,
         overage_unit = EXCLUDED.overage_unit, overage_price_cents = EXCLUDED.overage_price_cents`,
      [metric.key, metric.name, metric.kind, metric.unit, metric.overage_unit, metric.overage_price_cents],
    );
  }

  allPlans(tx: Tx): Promise<PlanRow[]> {
    return tx.rows<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans ORDER BY sort_order, key`);
  }

  async insertPlan(tx: Tx, key: string, values: PlanValues): Promise<string> {
    const id = newUuid();
    await tx.query(
      `INSERT INTO plans (id, key, name, description, price_cents, currency, interval, is_public, is_custom, trial_days, sort_order, provider_refs, metadata, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, '{}'::jsonb, $12)`,
      [id, key, values.name, values.description, values.price_cents, values.currency, values.interval, values.is_public, values.is_custom, values.trial_days, values.sort_order, values.archived_at],
    );
    return id;
  }

  async updatePlan(tx: Tx, id: string, values: PlanValues): Promise<void> {
    await tx.query(
      `UPDATE plans SET name = $2, description = $3, price_cents = $4, currency = $5, interval = $6, is_public = $7, is_custom = $8,
         trial_days = $9, sort_order = $10, archived_at = $11, updated_at = now() WHERE id = $1`,
      [id, values.name, values.description, values.price_cents, values.currency, values.interval, values.is_public, values.is_custom, values.trial_days, values.sort_order, values.archived_at],
    );
  }

  /** Merge one provider's refs into `plans.provider_refs` without touching the others. */
  async setProviderRefs(tx: Tx, key: string, provider: string, refs: Record<string, string>): Promise<void> {
    await tx.query(
      `UPDATE plans SET provider_refs = COALESCE(provider_refs, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb), updated_at = now()
       WHERE key = $1`,
      [key, provider, JSON.stringify(refs)],
    );
  }

  async archivePlan(tx: Tx, id: string, at: Date): Promise<void> {
    await tx.query(`UPDATE plans SET archived_at = $2, updated_at = now() WHERE id = $1`, [id, at]);
  }

  async insertPlanFeature(tx: Tx, planId: string, featureKey: string): Promise<void> {
    await tx.query(`INSERT INTO plan_features (plan_id, feature_key, enabled) VALUES ($1, $2, true)`, [planId, featureKey]);
  }

  async deletePlanFeature(tx: Tx, planId: string, featureKey: string): Promise<void> {
    await tx.query(`DELETE FROM plan_features WHERE plan_id = $1 AND feature_key = $2`, [planId, featureKey]);
  }

  async upsertPlanLimit(tx: Tx, planId: string, metric: string, values: PlanLimitValues): Promise<void> {
    await tx.query(
      `INSERT INTO plan_limits (plan_id, metric, limit_value, soft_limit_ratio, overage_unit, overage_price_cents) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (plan_id, metric) DO UPDATE SET limit_value = EXCLUDED.limit_value, soft_limit_ratio = EXCLUDED.soft_limit_ratio,
         overage_unit = EXCLUDED.overage_unit, overage_price_cents = EXCLUDED.overage_price_cents`,
      [planId, metric, values.limit_value, values.soft_limit_ratio, values.overage_unit, values.overage_price_cents],
    );
  }

  async deletePlanLimit(tx: Tx, planId: string, metric: string): Promise<void> {
    await tx.query(`DELETE FROM plan_limits WHERE plan_id = $1 AND metric = $2`, [planId, metric]);
  }
}
