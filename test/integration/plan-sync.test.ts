import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlanCatalogPush } from "../../src/billing/plan-catalog-push";
import { loadCatalog } from "../../src/subscriptions/catalog";
import { StubProviderServer } from "../support/stub-provider-server";
import { type Harness, startHarness, stopHarness, TEST_DB } from "./harness";

/**
 * `pnpm plans:sync --stripe [--apply]` against a stub Stripe
 * (`cli.py::_push_provider_catalog`): a dry run needs no credentials, and
 * `--apply` records the returned ids in `plans.provider_refs`.
 */
describe.skipIf(!TEST_DB)("plan sync to a provider (real Postgres, stub Stripe)", () => {
  let h: Harness;
  let stripe: StubProviderServer;
  let stripeUrl: string;
  let productSeq = 0;
  let priceSeq = 0;

  const beforeKey = process.env.SYNAPSE_STRIPE_SECRET_KEY;

  beforeAll(async () => {
    // The registry validates credentials up front, so the key must exist
    // before the settings are read — the stub never looks at it.
    process.env.SYNAPSE_STRIPE_SECRET_KEY = "sk_test_stub";
    h = await startHarness();
    stripe = new StubProviderServer({
      "POST /v1/products": {
        get json(): unknown {
          productSeq += 1;
          return { id: `prod_${String(productSeq)}` };
        },
      },
      "POST /v1/prices": {
        get json(): unknown {
          priceSeq += 1;
          return { id: `price_${String(priceSeq)}` };
        },
      },
    });
    stripeUrl = await stripe.start();
  });

  afterAll(async () => {
    await stripe.stop();
    await stopHarness(h);
    process.env.SYNAPSE_STRIPE_SECRET_KEY = beforeKey ?? "";
  });

  /** The stub speaks Stripe's URL shape, so route the provider's fetch at it. */
  const stubFetch = (url: string, init?: RequestInit): Promise<Response> => fetch(url.replace("https://api.stripe.com", stripeUrl), init);

  const paidPlans = (): string[] =>
    loadCatalog(process.env.SYNAPSE_PLANS_FILE ?? "config/plans.yaml")
      .plans.filter((plan) => plan.price_cents !== null && plan.price_cents !== undefined)
      .map((plan) => plan.key);

  it("dry-runs every paid plan without touching the provider or the rows", async () => {
    const result = await h.app.get(PlanCatalogPush).push("stripe");
    expect(result.pushed).toBe(0);
    expect(result.lines).toHaveLength(paidPlans().length);
    for (const line of result.lines) expect(line).toMatch(/^\[dry-run] stripe: upsert product\+price for .+ \(\d+ minor units\)$/);
    expect(stripe.calls).toHaveLength(0);
    const rows = await h.pool.query<{ provider_refs: Record<string, unknown> }>("SELECT provider_refs FROM plans");
    expect(rows.rows.every((row) => Object.keys(row.provider_refs).length === 0)).toBe(true);
  });

  it("skips custom-priced plans — there is no price to push", async () => {
    const catalog = loadCatalog(process.env.SYNAPSE_PLANS_FILE ?? "config/plans.yaml");
    const custom = catalog.plans.filter((plan) => plan.price_cents === null || plan.price_cents === undefined);
    const result = await h.app.get(PlanCatalogPush).push("stripe");
    expect(result.skipped).toBe(custom.length);
  });

  it("--apply creates a product and a price per paid plan and records the refs", async () => {
    const result = await h.app.get(PlanCatalogPush).push("stripe", { apply: true, fetchImpl: stubFetch });
    const keys = paidPlans();
    expect(result.pushed).toBe(keys.length);
    expect(stripe.calls.filter((call) => call.url.startsWith("/v1/products"))).toHaveLength(keys.length);
    expect(stripe.calls.filter((call) => call.url.startsWith("/v1/prices"))).toHaveLength(keys.length);

    // The product carries the plan key, and the price the plan's money
    const catalog = loadCatalog(process.env.SYNAPSE_PLANS_FILE ?? "config/plans.yaml");
    const first = catalog.plans.find((plan) => plan.key === keys[0]);
    const productBody = new URLSearchParams(stripe.calls[0]?.body ?? "");
    expect(productBody.get("metadata[plan_key]")).toBe(first?.key);
    expect(productBody.get("name")).toBe(first?.name);
    const priceBody = new URLSearchParams(stripe.calls[1]?.body ?? "");
    expect(priceBody.get("unit_amount")).toBe(String(first?.price_cents));
    expect(priceBody.get("currency")).toBe((first?.currency ?? catalog.defaults.currency).toLowerCase());
    expect(priceBody.get("recurring[interval]")).toBe(first?.interval ?? catalog.defaults.interval);

    const rows = await h.pool.query<{ key: string; provider_refs: Record<string, { product_id: string; price_id: string }> }>(
      "SELECT key, provider_refs FROM plans WHERE key = ANY($1::text[])",
      [keys],
    );
    expect(rows.rows).toHaveLength(keys.length);
    for (const row of rows.rows) {
      expect(row.provider_refs.stripe?.product_id).toMatch(/^prod_/);
      expect(row.provider_refs.stripe?.price_id).toMatch(/^price_/);
    }
  });

  it("merges into provider_refs instead of replacing them", async () => {
    await h.pool.query(`UPDATE plans SET provider_refs = provider_refs || '{"paddle": {"product_id": "pdl_1"}}'::jsonb WHERE key = $1`, [paidPlans()[0]]);
    await h.app.get(PlanCatalogPush).push("stripe", { apply: true, fetchImpl: stubFetch });
    const row = await h.pool.query<{ provider_refs: Record<string, unknown> }>("SELECT provider_refs FROM plans WHERE key = $1", [paidPlans()[0]]);
    expect(Object.keys(row.rows[0]?.provider_refs ?? {}).sort()).toEqual(["paddle", "stripe"]);
  });

  it("refuses a provider that cannot sync plans, without calling it", async () => {
    const before = stripe.calls.length;
    const result = await h.app.get(PlanCatalogPush).push("manual", { apply: true, fetchImpl: stubFetch });
    expect(result.lines).toEqual(["manual does not support plan sync; skipping"]);
    expect(result.pushed).toBe(0);
    expect(stripe.calls.length).toBe(before);
  });
});
