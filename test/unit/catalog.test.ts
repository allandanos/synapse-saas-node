import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PLANS_FILE } from "../../src/core/config";
import { CatalogInvalidError, type DomainError } from "../../src/core/errors";
import { loadCatalog, PlanCatalog } from "../../src/subscriptions/catalog";

/** Transliterated from the reference's tests/unit/subscriptions/test_catalog.py. */

const MINIMAL_HEAD = `
version: 1
features: [{key: basic_dashboard, name: Basic}]
metrics: [{key: users, name: Users, kind: gauge}]
`;

function write(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plans-"));
  const path = join(dir, "plans.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

function errorsOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogInvalidError);
    return JSON.stringify((error as DomainError).extras.errors ?? (error as Error).message);
  }
  throw new Error("expected CatalogInvalidError");
}

describe("shipped catalog", () => {
  const catalog = loadCatalog(DEFAULT_PLANS_FILE);

  it("loads and validates", () => {
    expect(catalog.plans.length).toBeGreaterThanOrEqual(4);
    expect(new Set(catalog.plans.map((p) => p.key))).toEqual(new Set(["free", "starter", "pro", "enterprise"]));
  });

  it("prices are integer minor units", () => {
    expect(catalog.plan("free")?.price_cents).toBe(0);
    expect(catalog.plan("starter")?.price_cents).toBe(49900);
    expect(catalog.plan("pro")?.price_cents).toBe(199900);
    expect(catalog.plan("enterprise")?.price).toBe("custom");
  });

  it("enterprise is not public; unlimited limits are null", () => {
    expect(catalog.plan("enterprise")?.is_public).toBe(false);
    expect(catalog.plan("pro")?.limits.projects).toBeNull();
    expect(catalog.defaults).toEqual({ currency: "PHP", interval: "month", trial_days: 0, soft_limit_ratio: 0.8 });
  });

  it("default settings point at the packaged catalog", () => {
    expect(DEFAULT_PLANS_FILE.endsWith("config/plans.yaml")).toBe(true);
  });
});

describe("validation failures", () => {
  it("unknown feature rejected", () => {
    const path = write(`${MINIMAL_HEAD}plans:\n  - {key: pro, name: Pro, price_cents: 100, features: [nonexistent_feature]}\n`);
    expect(errorsOf(() => loadCatalog(path))).toContain("nonexistent_feature");
  });

  it("unknown metric in limits", () => {
    const path = write(`${MINIMAL_HEAD}plans:\n  - {key: pro, name: Pro, price_cents: 100, limits: {warp_drives: 5}}\n`);
    expect(errorsOf(() => loadCatalog(path))).toContain("warp_drives");
  });

  it("duplicate plan keys", () => {
    const path = write(`${MINIMAL_HEAD}plans:\n  - {key: pro, name: Pro, price_cents: 100}\n  - {key: pro, name: Pro Again, price_cents: 200}\n`);
    expect(errorsOf(() => loadCatalog(path))).toContain("duplicate plan");
  });

  it("price_cents and custom both set / missing price / public custom", () => {
    expect(() => loadCatalog(write(`${MINIMAL_HEAD}plans:\n  - {key: pro, name: Pro, price_cents: 100, price: custom}\n`))).toThrow(CatalogInvalidError);
    expect(() => loadCatalog(write(`${MINIMAL_HEAD}plans:\n  - {key: pro, name: Pro}\n`))).toThrow(CatalogInvalidError);
    const path = write(`${MINIMAL_HEAD}plans:\n  - {key: pro, name: Pro, price: custom, is_public: true, is_custom: true}\n`);
    expect(errorsOf(() => loadCatalog(path))).toContain("concrete price");
  });

  it("missing file and malformed yaml", () => {
    expect(() => loadCatalog(join(tmpdir(), "nope-plans.yaml"))).toThrow(/not found/);
    expect(() => loadCatalog(write("version: [unclosed"))).toThrow(/not valid YAML/);
  });

  it("all errors reported at once", () => {
    const path = write(
      `${MINIMAL_HEAD}plans:\n  - {key: pro, name: Pro, price_cents: 100, features: [ghost], limits: {phantom: 1}}\n  - {key: pro, name: Dup, price_cents: 200}\n`,
    );
    const errors = errorsOf(() => loadCatalog(path));
    expect(errors).toContain("ghost");
    expect(errors).toContain("phantom");
    expect(errors).toContain("duplicate plan");
  });

  it("unknown keys are rejected (extra=forbid)", () => {
    expect(() => loadCatalog(write(`${MINIMAL_HEAD}plans:\n  - {key: pro, name: Pro, price_cents: 100, colour: red}\n`))).toThrow(CatalogInvalidError);
  });
});

function overageCatalog(): Record<string, unknown> {
  return {
    version: 1,
    features: [{ key: "f", name: "F" }],
    metrics: [
      { key: "ai_tokens", name: "AI", kind: "counter", overage: { unit: 1000, price_cents: 20 } },
      { key: "seats", name: "Seats", kind: "gauge" },
    ],
    plans: [
      { key: "starter", name: "S", price_cents: 100, limits: { ai_tokens: 10 } },
      { key: "pro", name: "P", price_cents: 200, limits: { ai_tokens: 100, seats: 5 }, overage: { ai_tokens: { unit: 1000, price_cents: 15 } } },
    ],
  };
}

describe("overage pricing in the catalog", () => {
  it("plan override beats metric default; unpriced ⇒ null", () => {
    const catalog = PlanCatalog.fromRaw(overageCatalog());
    expect(catalog.overageFor("starter", "ai_tokens")?.price_cents).toBe(20);
    expect(catalog.overageFor("pro", "ai_tokens")?.price_cents).toBe(15);
    expect(catalog.overageFor("pro", "seats")).toBeNull();
  });

  it("overage for an unlimited metric is rejected", () => {
    const bad = overageCatalog();
    (bad.plans as Record<string, unknown>[])[0]!.overage = { seats: { unit: 1, price_cents: 5 } };
    expect(errorsOf(() => PlanCatalog.fromRaw(bad))).toContain("prices overage for metrics it does not limit");
  });

  it("unit must be positive", () => {
    const bad = overageCatalog();
    (bad.metrics as Record<string, unknown>[])[0]!.overage = { unit: 0, price_cents: 20 };
    expect(() => PlanCatalog.fromRaw(bad)).toThrow(CatalogInvalidError);
  });
});
