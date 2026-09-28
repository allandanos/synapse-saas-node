import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CatalogInvalidError } from "../core/errors";

/**
 * Plan catalog: YAML → validated model (transliterated from the reference's
 * `subscriptions/catalog.py`). Fails fast on any inconsistency — unknown
 * feature/metric, duplicate keys, custom-price mismatches — reporting every
 * error at once. The catalog is the pricing source of truth; the database is
 * a projection of it (see `catalog-sync.ts`).
 */

const KEY_RE = /^[a-z0-9_]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const INTERVAL_RE = /^(month|year)$/;

const defaultsSchema = z.object({
  currency: z.string().regex(CURRENCY_RE).default("PHP"),
  interval: z.string().regex(INTERVAL_RE).default("month"),
  trial_days: z.number().int().min(0).default(0),
  soft_limit_ratio: z.number().min(0).max(1).nullable().default(0.8),
});

const featureSchema = z.object({ key: z.string().regex(KEY_RE), name: z.string(), category: z.string().nullable().default(null) }).strict();

/** Price for usage beyond a limit: `price_cents` per `unit` units (ceil). */
const overageSchema = z.object({ unit: z.number().int().min(1).default(1), price_cents: z.number().int().min(0) }).strict();

const metricSchema = z
  .object({
    key: z.string().regex(KEY_RE),
    name: z.string(),
    kind: z.enum(["counter", "gauge"]),
    unit: z.string().nullable().default(null),
    soft_limit_ratio: z.number().min(0).max(1).nullable().default(null),
    // Default overage pricing for every plan that limits this metric. Omit ⇒ enforced (402), never billed.
    overage: overageSchema.nullable().default(null),
  })
  .strict();

const planSchema = z
  .object({
    key: z.string().regex(KEY_RE),
    name: z.string(),
    description: z.string().nullable().default(null),
    // Exactly one of price_cents / price: custom (xor)
    price_cents: z.number().int().min(0).nullable().default(null),
    price: z.literal("custom").nullable().default(null),
    currency: z.string().regex(CURRENCY_RE).nullable().default(null),
    interval: z.string().regex(INTERVAL_RE).nullable().default(null),
    is_public: z.boolean().default(true),
    is_custom: z.boolean().default(false),
    trial_days: z.number().int().min(0).nullable().default(null),
    sort_order: z.number().int().default(0),
    features: z.array(z.string()).default([]),
    // value omitted or null ⇒ unlimited
    limits: z.record(z.number().int().nullable()).default({}),
    // Per-plan overage override (metric ⇒ pricing); metrics must be limited here
    overage: z.record(overageSchema).default({}),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const hasCents = plan.price_cents !== null;
    const isCustom = plan.price === "custom";
    if (hasCents && isCustom) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `plan '${plan.key}': set either price_cents or price: custom, not both` });
    if (!hasCents && !isCustom) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `plan '${plan.key}': must set price_cents or price: custom` });
  });

const catalogSchema = z
  .object({
    version: z.number().int(),
    defaults: defaultsSchema.default({}),
    features: z.array(featureSchema),
    metrics: z.array(metricSchema),
    plans: z.array(planSchema),
  })
  .strict();

export type CatalogDefaults = z.infer<typeof defaultsSchema>;
export type FeatureDefinition = z.infer<typeof featureSchema>;
export type OverageDefinition = z.infer<typeof overageSchema>;
export type MetricDefinition = z.infer<typeof metricSchema>;
export type PlanDefinition = z.infer<typeof planSchema>;

function duplicates(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const key of keys) (seen.has(key) ? dup : seen).add(key);
  return [...dup].sort();
}

export class PlanCatalog {
  private constructor(
    readonly version: number,
    readonly defaults: CatalogDefaults,
    readonly features: readonly FeatureDefinition[],
    readonly metrics: readonly MetricDefinition[],
    readonly plans: readonly PlanDefinition[],
  ) {}

  /** Validate a parsed YAML document. Throws `CatalogInvalidError` with every error in `extras.errors`. */
  static fromRaw(raw: unknown): PlanCatalog {
    const parsed = catalogSchema.safeParse(raw);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => `${issue.path.join(".") || "catalog"}: ${issue.message}`);
      throw new CatalogInvalidError(`Plans file failed validation: ${errors.join("; ")}`, { errors });
    }
    const catalog = new PlanCatalog(parsed.data.version, parsed.data.defaults, parsed.data.features, parsed.data.metrics, parsed.data.plans);
    catalog.crossValidate();
    return catalog;
  }

  private crossValidate(): void {
    const errors: string[] = [];
    const featureKeys = this.features.map((f) => f.key);
    const metricKeys = this.metrics.map((m) => m.key);
    const planKeys = this.plans.map((p) => p.key);
    const dupFeatures = duplicates(featureKeys);
    if (dupFeatures.length > 0) errors.push(`duplicate feature keys: ${JSON.stringify(dupFeatures)}`);
    const dupMetrics = duplicates(metricKeys);
    if (dupMetrics.length > 0) errors.push(`duplicate metric keys: ${JSON.stringify(dupMetrics)}`);
    const dupPlans = duplicates(planKeys);
    if (dupPlans.length > 0) errors.push(`duplicate plan keys: ${JSON.stringify(dupPlans)}`);

    const featureSet = new Set(featureKeys);
    const metricSet = new Set(metricKeys);
    for (const plan of this.plans) {
      const unknown = [...new Set(plan.features.filter((f) => !featureSet.has(f)))].sort();
      if (unknown.length > 0) errors.push(`plan '${plan.key}' references unknown features: ${JSON.stringify(unknown)}`);
      const unknownMetrics = Object.keys(plan.limits).filter((m) => !metricSet.has(m)).sort();
      if (unknownMetrics.length > 0) errors.push(`plan '${plan.key}' limits unknown metrics: ${JSON.stringify(unknownMetrics)}`);
      const unpriced = Object.keys(plan.overage).filter((m) => !(m in plan.limits)).sort();
      if (unpriced.length > 0) errors.push(`plan '${plan.key}' prices overage for metrics it does not limit: ${JSON.stringify(unpriced)}`);
      if (plan.is_public && plan.price_cents === null) errors.push(`public plan '${plan.key}' must have a concrete price_cents`);
    }
    if (errors.length > 0) throw new CatalogInvalidError("Invalid plan catalog", { errors });
  }

  featureKeys(): ReadonlySet<string> {
    return new Set(this.features.map((f) => f.key));
  }

  metricKeys(): ReadonlySet<string> {
    return new Set(this.metrics.map((m) => m.key));
  }

  plan(key: string): PlanDefinition | undefined {
    return this.plans.find((p) => p.key === key);
  }

  metric(key: string): MetricDefinition | undefined {
    return this.metrics.find((m) => m.key === key);
  }

  /** Effective overage pricing: the plan's override, else the metric's default. */
  overageFor(planKey: string, metric: string): OverageDefinition | null {
    const plan = this.plan(planKey);
    if (plan && metric in plan.overage) return plan.overage[metric] ?? null;
    return this.metric(metric)?.overage ?? null;
  }
}

/** Load + validate the catalog at `path`. Raises `CatalogInvalidError` with all errors at once. */
export function loadCatalog(path: string): PlanCatalog {
  if (!existsSync(path)) throw new CatalogInvalidError(`Plans file not found: ${path}`, { path });
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CatalogInvalidError(`Plans file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`, { path });
  }
  try {
    return PlanCatalog.fromRaw(raw);
  } catch (error) {
    if (error instanceof CatalogInvalidError && !("path" in error.extras)) {
      throw new CatalogInvalidError(error.message, { ...error.extras, path });
    }
    throw error;
  }
}
