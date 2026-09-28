import { Inject, Injectable, Logger } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import { loadCatalog, type PlanCatalog } from "./catalog";
import { PlansRepository, type PlanRow, type PlanValues } from "./plans.repository";

export interface SyncResult {
  features_added: number;
  metrics_added: number;
  plans_added: number;
  plans_updated: number;
  plans_archived: number;
}

const PLAN_VALUE_KEYS: (keyof PlanValues)[] = ["name", "description", "price_cents", "currency", "interval", "is_public", "is_custom", "trial_days", "sort_order", "archived_at"];

function planChanged(existing: PlanRow, values: PlanValues): boolean {
  return PLAN_VALUE_KEYS.some((key) => {
    const current = existing[key];
    const wanted = values[key];
    if (current instanceof Date || wanted instanceof Date) return (current as Date | null)?.getTime() !== (wanted as Date | null)?.getTime();
    return current !== wanted;
  });
}

/**
 * Catalog → DB sync (transliterated from the reference's `subscriptions/sync.py`).
 * Idempotent upsert keyed on natural keys. Never deletes plans (removals become
 * `archived_at`), never touches `provider_refs`, never rewrites existing
 * subscriptions' `plan_snapshot` — YAML price changes must not rewrite history.
 * Runs at boot (`SYNAPSE_AUTO_SYNC_PLANS`) and as `pnpm plans:sync`.
 */
@Injectable()
export class PlanCatalogSync {
  private readonly logger = new Logger(PlanCatalogSync.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly plans: PlansRepository,
  ) {}

  /** Load `SYNAPSE_PLANS_FILE` and sync it in one transaction. */
  async syncFromFile(path: string = this.settings.SYNAPSE_PLANS_FILE): Promise<SyncResult> {
    const catalog = loadCatalog(path);
    const result = await this.db.transaction((tx) => this.syncIn(tx, catalog));
    this.logger.log(`plans synced: ${JSON.stringify(result)}`);
    return result;
  }

  sync(catalog: PlanCatalog): Promise<SyncResult> {
    return this.db.transaction((tx) => this.syncIn(tx, catalog));
  }

  async syncIn(tx: Tx, catalog: PlanCatalog): Promise<SyncResult> {
    const result: SyncResult = { features_added: 0, metrics_added: 0, plans_added: 0, plans_updated: 0, plans_archived: 0 };
    const now = new Date();

    // ── Features registry ───────────────────────────────────────────────────
    const existingFeatures = await this.plans.allFeatureKeys(tx);
    for (const feature of catalog.features) {
      if (existingFeatures.has(feature.key)) continue;
      await this.plans.insertFeature(tx, { key: feature.key, name: feature.name, category: feature.category });
      result.features_added += 1;
    }

    // ── Metrics registry (the catalog is the source of truth for a metric's shape too) ──
    const existingMetrics = await this.plans.allMetricKeys(tx);
    for (const metric of catalog.metrics) {
      await this.plans.upsertMetric(tx, {
        key: metric.key,
        name: metric.name,
        kind: metric.kind,
        unit: metric.unit,
        overage_unit: metric.overage?.unit ?? null,
        overage_price_cents: metric.overage?.price_cents ?? null,
      });
      if (!existingMetrics.has(metric.key)) result.metrics_added += 1;
    }

    // ── Plans ───────────────────────────────────────────────────────────────
    const existingPlans = new Map((await this.plans.allPlans(tx)).map((plan) => [plan.key, plan]));
    const defaults = catalog.defaults;
    for (const [order, planDef] of catalog.plans.entries()) {
      const values: PlanValues = {
        name: planDef.name,
        description: planDef.description,
        price_cents: planDef.price_cents,
        currency: planDef.currency ?? defaults.currency,
        interval: planDef.interval ?? defaults.interval,
        is_public: planDef.is_public,
        is_custom: planDef.is_custom || planDef.price === "custom",
        trial_days: planDef.trial_days ?? defaults.trial_days,
        sort_order: planDef.sort_order || order,
        archived_at: null, // re-listing a plan revives it
      };
      const existing = existingPlans.get(planDef.key);
      let planId: string;
      if (!existing) {
        planId = await this.plans.insertPlan(tx, planDef.key, values);
        result.plans_added += 1;
      } else {
        planId = existing.id;
        if (planChanged(existing, values)) {
          await this.plans.updatePlan(tx, planId, values);
          result.plans_updated += 1;
        }
      }
      await this.syncPlanFeatures(tx, planId, planDef.features);
      await this.syncPlanLimits(tx, planId, planDef.key, planDef.limits, catalog);
    }

    // ── Archive plans removed from the catalog ──────────────────────────────
    const catalogKeys = new Set(catalog.plans.map((p) => p.key));
    for (const [key, plan] of existingPlans) {
      if (!catalogKeys.has(key) && plan.archived_at === null) {
        await this.plans.archivePlan(tx, plan.id, now);
        result.plans_archived += 1;
      }
    }
    return result;
  }

  private async syncPlanFeatures(tx: Tx, planId: string, featureKeys: readonly string[]): Promise<void> {
    const existing = new Set((await this.plans.planFeatures(tx, planId)).map((f) => f.feature_key));
    const wanted = new Set(featureKeys);
    for (const key of wanted) if (!existing.has(key)) await this.plans.insertPlanFeature(tx, planId, key);
    for (const key of existing) if (!wanted.has(key)) await this.plans.deletePlanFeature(tx, planId, key);
  }

  private async syncPlanLimits(tx: Tx, planId: string, planKey: string, limits: Readonly<Record<string, number | null>>, catalog: PlanCatalog): Promise<void> {
    const existing = new Set((await this.plans.planLimits(tx, planId)).map((l) => l.metric));
    for (const [metric, value] of Object.entries(limits)) {
      // A metric's own ratio wins; otherwise the catalog default.
      const soft = catalog.metric(metric)?.soft_limit_ratio ?? catalog.defaults.soft_limit_ratio;
      const overage = catalog.overageFor(planKey, metric);
      await this.plans.upsertPlanLimit(tx, planId, metric, {
        limit_value: value,
        soft_limit_ratio: soft,
        overage_unit: overage?.unit ?? null,
        overage_price_cents: overage?.price_cents ?? null,
      });
    }
    for (const metric of existing) if (!(metric in limits)) await this.plans.deletePlanLimit(tx, planId, metric);
  }
}
