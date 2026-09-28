import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, makeTenant, platformHeaders, startHarness, stopHarness, TEST_DB, uid } from "./harness";

/**
 * Milestone 3 over HTTP against a real Postgres: free plan → consume until
 * 402 → trial → paid limits → idempotent record → batch rollback → gauges →
 * operator grants → key auth meters api_requests → 10-way concurrency.
 * Mirrors the reference's test_monetization / test_usage_consume_batch /
 * test_plan_change_provider / test_operator_split journeys.
 */
describe.skipIf(!TEST_DB)("milestone 3 monetization (real Postgres)", () => {
  let h: Harness;
  let http: Harness["http"];
  let pool: Harness["pool"];

  beforeAll(async () => {
    h = await startHarness();
    ({ http, pool } = h);
  });

  afterAll(() => stopHarness(h));

  async function used(headers: Record<string, string>, metric: string): Promise<number> {
    const res = await http.get("/v1/usage/check").set(headers).query({ metric });
    expect(res.status, res.text).toBe(200);
    return res.body.used;
  }

  it("plans are a paginated public catalog synced from plans.yaml", async () => {
    const t = await makeTenant(h);
    const plans = await http.get("/v1/plans").set(t.bearer);
    expect(plans.status).toBe(200);
    expect(plans.headers["x-total-count"]).toBe("3");
    expect(plans.body.map((p: { key: string }) => p.key)).toEqual(["free", "starter", "pro"]); // enterprise is not public
    const free = plans.body[0];
    expect(free).toMatchObject({ key: "free", price_cents: 0, currency: "PHP", interval: "month", trial_days: 0, is_custom: false });
    expect(free.features).toEqual([
      { feature_key: "api_access", enabled: true },
      { feature_key: "basic_dashboard", enabled: true },
    ]);
    expect(free.limits).toContainEqual({ metric: "api_requests", limit_value: 10000, soft_limit_ratio: 0.8 });
    expect((await http.get("/v1/plans").set(t.bearer).query({ limit: 101 })).status).toBe(422);
    expect((await http.get("/v1/plans").set(t.bearer).query({ limit: 1, offset: 1 })).body.map((p: { key: string }) => p.key)).toEqual(["starter"]);

    // the sync is idempotent: a second run changes nothing
    const before = await pool.query(`SELECT count(*)::int AS n FROM plan_limits`);
    const { PlanCatalogSync } = await import("../../src/subscriptions/catalog-sync");
    expect(await h.app.get(PlanCatalogSync).syncFromFile()).toEqual({ features_added: 0, metrics_added: 0, plans_added: 0, plans_updated: 0, plans_archived: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM plan_limits`)).rows[0].n).toBe(before.rows[0].n);
  });

  it("a new org is on free with a seat gauge of one; the free plan meters until 402", async () => {
    const t = await makeTenant(h);
    const current = await http.get("/v1/subscription").set(t.headers);
    expect(current.status, current.text).toBe(200);
    expect(current.body.subscription).toMatchObject({ status: "active", cancel_at_period_end: false, canceled_at: null, trial_ends_at: null, organization_id: t.orgId });
    expect(current.body.subscription.plan.key).toBe("free");
    expect(current.body.subscription.plan_snapshot).toMatchObject({ key: "free", price_cents: 0, features: ["api_access", "basic_dashboard"], limits: { users: 3 } });
    expect(current.body.entitlements).toMatchObject({ organization_id: t.orgId, plan_key: "free", subscription_status: "active", features: ["api_access", "basic_dashboard"] });
    expect(current.body.entitlements.limits.users).toEqual({ value: 3, soft_limit_ratio: 0.8 });
    expect(current.body.usage).toEqual([{ metric: "users", used: 1 }]);

    const ok = await http.post("/v1/usage/consume").set(t.headers).send({ events: [{ metric: "api_requests", quantity: 9_999 }] });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toEqual({ metric: "api_requests", quantity: 9_999, total: 9_999, limit: 10_000, remaining: 1, within_limit: true, deduplicated: false });
    const breach = await http.post("/v1/usage/consume").set(t.headers).send({ events: [{ metric: "api_requests", quantity: 5 }] });
    expect(breach.status).toBe(402);
    expect(breach.body).toMatchObject({ title: "usage limit exceeded", metric: "api_requests", limit: 10_000, used: 9_999, attempted: 5, upgrade_url: "/dashboard/billing" });
    expect(await used(t.headers, "api_requests")).toBe(9_999); // the breach rolled back

    // the soft limit (80%) fired exactly once, the hard limit not yet
    const outbox = await pool.query(`SELECT event_type, payload FROM outbox_events WHERE organization_id = $1 AND event_type LIKE 'usage.%'`, [t.orgId]);
    expect(outbox.rows.map((r) => r.event_type)).toEqual(["usage.soft_limit_reached"]);
    expect(outbox.rows[0].payload).toMatchObject({ organization_id: t.orgId, metric: "api_requests", threshold: 8_000, total: 9_999, limit: 10_000 });

    const summary = await http.get("/v1/usage/summary").set(t.headers);
    expect(summary.body.period).toMatch(/^\d{4}-\d{2}-01$/);
    expect(summary.body.metrics).toContainEqual({ metric: "api_requests", used: 9_999, limit: 10_000, remaining: 1, within_limit: true, soft_limit: 8_000, soft_limit_breached: true });
    expect(summary.body.metrics).toContainEqual({ metric: "users", used: 1, limit: 3, remaining: 2, within_limit: true, soft_limit: 2, soft_limit_breached: false });
    expect((await http.get("/v1/usage/summary").set(t.headers).query({ period: "2001-1" })).status).toBe(422);
    const past = await http.get("/v1/usage/summary").set(t.headers).query({ period: "2001-01" });
    expect(past.body.period).toBe("2001-01-01");
    expect(past.body.metrics.map((m: { metric: string }) => m.metric)).toEqual(["users"]); // gauges survive the period
    expect((await http.post("/v1/usage/events").set(t.headers).send({ events: [{ metric: "warp_drives" }] })).status).toBe(422);
    const record = await http.post("/v1/usage/events").set(t.headers).send({ events: [{ metric: "api_requests", quantity: 50_000 }] });
    expect(record.status).toBe(201); // record never blocks
    expect(record.body[0]).toMatchObject({ total: 59_999, deduplicated: false });
  });

  it("trial → paid limits → cancel/resume → change with proration; unknown plan is 404", async () => {
    const t = await makeTenant(h);
    expect((await http.post("/v1/subscription/trial").set(t.headers).send({ plan_key: "free" })).status).toBe(409); // no trial period
    const trial = await http.post("/v1/subscription/trial").set(t.headers).send({ plan_key: "starter" });
    expect(trial.status, trial.text).toBe(201);
    expect(trial.body).toMatchObject({ status: "trialing", cancel_at_period_end: false });
    expect(trial.body.plan.key).toBe("starter");
    expect(trial.body.trial_ends_at).toBe(trial.body.current_period_end);
    const again = await http.post("/v1/subscription/trial").set(t.headers).send({ plan_key: "pro" });
    expect(again.status).toBe(409);
    expect(again.body.title).toBe("trial not allowed");
    const ent = await http.get("/v1/entitlements").set(t.headers);
    expect(ent.body).toMatchObject({ plan_key: "starter", subscription_status: "trialing" });
    expect(ent.body.features).toContain("reports");
    expect(ent.body.limits.users.value).toBe(10);
    expect(ent.body.limits.ai_tokens).toEqual({ value: 100_000, soft_limit_ratio: 0.8 });

    const cancelled = await http.post("/v1/subscription/cancel").set(t.headers).send({ at_period_end: true });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancel_at_period_end).toBe(true);
    const resumed = await http.post("/v1/subscription/resume").set(t.headers);
    expect(resumed.body.cancel_at_period_end).toBe(false);
    expect((await http.post("/v1/subscription/resume").set(t.headers)).status).toBe(404);

    const unknown = await http.post("/v1/subscription/change").set(t.headers).send({ plan_key: "nope" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.title).toBe("plan not found");

    // trial → paid: no live paid period ⇒ fresh cycle, nothing to prorate
    const paid = await http.post("/v1/subscription/change").set(t.headers).send({ plan_key: "starter" });
    expect(paid.status, paid.text).toBe(200);
    expect(paid.body).toMatchObject({ status: "active", trial_ends_at: trial.body.trial_ends_at });
    expect(paid.body.plan_snapshot).toMatchObject({ key: "starter", price_cents: 49900, overage: { ai_tokens: { unit: 1000, price_cents: 20 } } });
    expect(new Date(paid.body.current_period_end).getTime() - new Date(paid.body.current_period_start).getTime()).toBe(30 * 86_400_000);

    // paid → paid mid-period keeps the period and records an arrears credit
    const now = Date.now();
    await pool.query(`UPDATE subscriptions SET current_period_start = $2, current_period_end = $3 WHERE id = $1`, [
      paid.body.id,
      new Date(now - 15 * 86_400_000),
      new Date(now + 15 * 86_400_000),
    ]);
    const upgraded = await http.post("/v1/subscription/change").set(t.headers).send({ plan_key: "pro" });
    expect(upgraded.status, upgraded.text).toBe(200);
    expect(upgraded.body.plan.key).toBe("pro");
    expect(Math.abs(new Date(upgraded.body.current_period_end).getTime() - (now + 15 * 86_400_000))).toBeLessThan(1000);
    const sub = await pool.query(`SELECT pending_adjustments, provider FROM subscriptions WHERE id = $1`, [paid.body.id]);
    expect(sub.rows[0].provider).toBe("manual");
    const [adjustment] = sub.rows[0].pending_adjustments;
    expect(adjustment).toMatchObject({ kind: "proration", from_plan: "starter", to_plan: "pro", from_price_cents: 49900, to_price_cents: 199900 });
    expect(adjustment.amount_cents).toBeGreaterThanOrEqual(-75100);
    expect(adjustment.amount_cents).toBeLessThanOrEqual(-74900);
    expect(adjustment.description).toMatch(/^Plan change starter → pro: credit for 50\.0% of the period/);

    const events = await pool.query(`SELECT event_type, payload FROM outbox_events WHERE organization_id = $1 AND event_type LIKE 'subscription.%' ORDER BY id`, [t.orgId]);
    expect(events.rows.map((r) => r.event_type)).toEqual([
      "subscription.activated",
      "subscription.trial_started",
      "subscription.canceled",
      "subscription.resumed",
      "subscription.plan_changed",
      "subscription.plan_changed",
    ]);
    expect(events.rows[5].payload).toMatchObject({ from_plan: "starter", to_plan: "pro", plan_key: "pro", status: "active" });

    // immediate cancel collapses entitlements (the default-plan fallback names the plan, but no
    // occupying subscription ⇒ no plan features/limits — the reference's test_cancel_immediately); nothing left to cancel again
    const gone = await http.post("/v1/subscription/cancel").set(t.headers).send({ at_period_end: false });
    expect(gone.body.status).toBe("canceled");
    expect((await http.get("/v1/entitlements").set(t.headers)).body).toEqual({ organization_id: t.orgId, plan_key: "free", subscription_status: null, features: [], limits: {} });
    expect((await http.get("/v1/subscription").set(t.headers)).body.subscription).toBeNull();
    expect((await http.post("/v1/subscription/cancel").set(t.headers).send({})).status).toBe(404);
  });

  it("idempotent record/consume, batch rollback, gauges", async () => {
    const t = await makeTenant(h);
    const key = `evt-${uid()}`;
    const body = { events: [{ metric: "api_requests", quantity: 7, idempotency_key: key }] };
    const first = await http.post("/v1/usage/events").set(t.headers).send(body);
    const second = await http.post("/v1/usage/events").set(t.headers).send(body);
    expect(first.status).toBe(201);
    expect(first.body[0]).toEqual({ metric: "api_requests", quantity: 7, total: 7, deduplicated: false });
    expect(second.body[0]).toEqual({ metric: "api_requests", quantity: 7, total: 7, deduplicated: true });
    // concurrent retries: one counts, the rest replay
    const racers = await Promise.all(Array.from({ length: 4 }, () => http.post("/v1/usage/events").set(t.headers).send({ events: [{ metric: "api_requests", quantity: 9, idempotency_key: `race-${key}` }] })));
    expect(racers.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(racers.map((r) => r.body[0].deduplicated).sort()).toEqual([false, true, true, true]);
    expect(await used(t.headers, "api_requests")).toBe(16);
    const consume = { events: [{ metric: "api_requests", quantity: 5, idempotency_key: `c-${key}` }] };
    const c1 = await http.post("/v1/usage/consume").set(t.headers).send(consume);
    const c2 = await http.post("/v1/usage/consume").set(t.headers).send(consume);
    expect(c1.body).toMatchObject({ total: 21, deduplicated: false });
    expect(c2.body).toEqual({ metric: "api_requests", quantity: 5, total: 21, limit: 10_000, remaining: 9_979, within_limit: true, deduplicated: true });
    expect((await pool.query(`SELECT count(*)::int AS n FROM usage_events WHERE organization_id = $1`, [t.orgId])).rows[0].n).toBe(3);

    // a breached consume does not burn the key: raise the limit, the same key succeeds
    const big = { events: [{ metric: "api_requests", quantity: 20_000, idempotency_key: `big-${key}` }] };
    expect((await http.post("/v1/usage/consume").set(t.headers).send(big)).status).toBe(402);
    const platform = await platformHeaders(h);
    const raised = await http.post(`/v1/admin/orgs/${t.orgId}/entitlements/grants`).set(platform).send({ feature_key: "limit:api_requests", source: "addon", limit_value: 50_000 });
    expect(raised.status, raised.text).toBe(201);
    const retried = await http.post("/v1/usage/consume").set(t.headers).send(big);
    expect(retried.status, retried.text).toBe(200);
    expect(retried.body).toMatchObject({ deduplicated: false, total: 20_021, limit: 50_000 });

    // consume takes exactly one event; batches are all-or-nothing
    const two = await http.post("/v1/usage/consume").set(t.headers).send({ events: [{ metric: "api_requests" }, { metric: "api_requests" }] });
    expect(two.status).toBe(422);
    expect(two.body).toMatchObject({ title: "validation failed", events: 2, batch_url: "/v1/usage/consume-batch" });
    const batch = await http.post("/v1/usage/consume-batch").set(t.headers).send({ events: [{ metric: "api_requests", quantity: 3 }, { metric: "api_requests", quantity: 4 }] });
    expect(batch.status).toBe(200);
    expect(batch.body.map((r: { total: number }) => r.total)).toEqual([20_024, 20_028]);
    const rollback = await http.post("/v1/usage/consume-batch").set(t.headers).send({ events: [{ metric: "api_requests", quantity: 1 }, { metric: "api_requests", quantity: 40_000 }] });
    expect(rollback.status).toBe(402);
    expect(rollback.body).toMatchObject({ metric: "api_requests", limit: 50_000 });
    expect(await used(t.headers, "api_requests")).toBe(20_028);

    // gauges: levels in the fixed bucket, never below zero, positive deltas capacity-checked (free: projects = 2)
    const set = await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "projects", value: 2 });
    expect(set.body).toEqual({ metric: "projects", quantity: 2, total: 2, limit: 2, remaining: 0, within_limit: true, deduplicated: false });
    expect((await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "projects", delta: -1 })).body.total).toBe(1);
    expect((await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "projects", delta: -5 })).body.total).toBe(0);
    for (let i = 0; i < 2; i += 1) expect((await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "projects", delta: 1 })).status).toBe(200);
    const full = await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "projects", delta: 1 });
    expect(full.status).toBe(402);
    expect(full.body).toMatchObject({ metric: "projects", limit: 2, used: 2 });
    expect(await used(t.headers, "projects")).toBe(2);
    const sync = await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "projects", value: 5 }); // a sync is never refused
    expect(sync.status).toBe(200);
    expect(sync.body.within_limit).toBe(false);
    expect((await pool.query(`SELECT period_start::text AS p FROM usage_counters WHERE organization_id = $1 AND metric = 'projects'`, [t.orgId])).rows[0].p).toBe("1970-01-01");
    for (const path of ["/v1/usage/events", "/v1/usage/consume"]) {
      const res = await http.post(path).set(t.headers).send({ events: [{ metric: "projects", quantity: 1 }] });
      expect(res.status, path).toBe(422);
      expect(res.body.kind).toBe("gauge");
    }
    const counter = await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "api_requests", value: 1 });
    expect(counter.status).toBe(422);
    expect(counter.body.kind).toBe("counter");
    expect((await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "projects" })).status).toBe(422);
    expect((await http.post("/v1/usage/gauge").set(t.headers).send({ metric: "projects", value: 1, delta: 1 })).status).toBe(422);
  });

  it("seats: the users gauge follows memberships and the invite is capped (402, metric users)", async () => {
    const t = await makeTenant(h);
    expect(await used(t.headers, "users")).toBe(1);
    const a = await http.post("/v1/orgs/current/members/invite").set(t.headers).send({ email: `a-${uid()}@example.com` });
    expect(a.status).toBe(201);
    expect(await used(t.headers, "users")).toBe(2); // pending invites hold a seat
    expect((await http.post("/v1/orgs/current/members/invite").set(t.headers).send({ email: `b-${uid()}@example.com` })).status).toBe(201);
    const blocked = await http.post("/v1/orgs/current/members/invite").set(t.headers).send({ email: `c-${uid()}@example.com` });
    expect(blocked.status).toBe(402);
    expect(blocked.body).toMatchObject({ title: "usage limit exceeded", metric: "users", limit: 3, used: 3, upgrade_url: "/dashboard/billing" });
    expect((await http.delete(`/v1/memberships/${a.body.id}`).set(t.headers)).status).toBe(204);
    expect(await used(t.headers, "users")).toBe(2);
    // an upgrade unblocks the seat
    expect((await http.post("/v1/subscription/change").set(t.headers).send({ plan_key: "starter" })).status).toBe(200);
    expect((await http.post("/v1/orgs/current/members/invite").set(t.headers).send({ email: `c-${uid()}@example.com` })).status).toBe(201);
    expect((await http.post("/v1/orgs/current/members/invite").set(t.headers).send({ email: `d-${uid()}@example.com` })).status).toBe(201);
    expect(await used(t.headers, "users")).toBe(4);
  });

  it("operator grants are platform-only; tenants see 404; revoke is scoped to the path org", async () => {
    const t = await makeTenant(h);
    const other = await makeTenant(h, "other");
    const platform = await platformHeaders(h);
    expect((await http.post(`/v1/admin/orgs/${t.orgId}/entitlements/grants`).set(t.headers).send({ feature_key: "sso", source: "enterprise" })).status).toBe(404);
    expect((await http.get(`/v1/admin/orgs/${t.orgId}/entitlements`).set(t.headers)).status).toBe(404);
    expect((await http.post(`/v1/admin/orgs/${t.orgId}/entitlements/grants`).set(platform).send({ feature_key: "sso", source: "nope" })).status).toBe(422);

    const grant = await http.post(`/v1/admin/orgs/${t.orgId}/entitlements/grants`).set(platform).send({ feature_key: "sso", source: "beta", duration_days: 7, note: "pilot" });
    expect(grant.status, grant.text).toBe(201);
    expect(grant.body).toEqual({ id: expect.any(String), feature_key: "sso", source: "beta" });
    const row = await pool.query(`SELECT source, enabled, ends_at, note, created_by_user_id, limit_value FROM entitlements WHERE id = $1`, [grant.body.id]);
    expect(row.rows[0]).toMatchObject({ source: "beta", enabled: true, note: "pilot", limit_value: null });
    expect(row.rows[0].created_by_user_id).not.toBeNull();
    expect(row.rows[0].ends_at.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await http.get(`/v1/admin/orgs/${t.orgId}/entitlements`).set(platform)).body.features).toContain("sso");
    expect((await http.get("/v1/entitlements").set(t.headers)).body.features).toContain("sso");
    expect((await http.get("/v1/entitlements").set(other.headers)).body.features).not.toContain("sso");

    // kill switch: a higher-priority disabled grant removes a plan feature
    const kill = await http.post(`/v1/admin/orgs/${t.orgId}/entitlements/grants`).set(platform).send({ feature_key: "api_access", source: "override", enabled: false });
    expect(kill.status).toBe(201);
    expect((await http.get("/v1/entitlements").set(t.headers)).body.features).toEqual(["basic_dashboard", "sso"]);

    expect((await http.delete(`/v1/admin/orgs/${other.orgId}/entitlements/grants/${grant.body.id}`).set(platform)).status).toBe(404);
    expect((await http.delete(`/v1/admin/orgs/${t.orgId}/entitlements/grants/${grant.body.id}`).set(platform)).status).toBe(204);
    expect((await http.delete(`/v1/admin/orgs/${t.orgId}/entitlements/grants/${kill.body.id}`).set(platform)).status).toBe(204);
    expect((await http.delete(`/v1/admin/orgs/${t.orgId}/entitlements/grants/${kill.body.id}`).set(platform)).status).toBe(204); // idempotent-ish: still found, revoked again
    expect((await http.get("/v1/entitlements").set(t.headers)).body.features).toEqual(["api_access", "basic_dashboard"]);
    const events = await pool.query(`SELECT event_type, audience FROM outbox_events WHERE organization_id = $1 AND event_type LIKE 'entitlement.%' ORDER BY id`, [t.orgId]);
    expect(events.rows.map((r) => `${r.event_type}:${r.audience}`)).toEqual([
      "entitlement.granted:public",
      "entitlement.granted:public",
      "entitlement.revoked:public",
      "entitlement.revoked:public",
      "entitlement.revoked:public",
    ]);
  });

  it("API-key authentication meters api_requests best-effort, without needing a permission", async () => {
    const t = await makeTenant(h);
    const key = await http.post("/v1/api-keys").set(t.headers).send({ name: "ci", scopes: ["usage:read"] });
    expect(key.status).toBe(201);
    const asKey = { Authorization: `Bearer ${key.body.key}` };
    const consumed = await http.post("/v1/usage/consume").set(asKey).send({ events: [{ metric: "api_requests", quantity: 1 }] });
    expect(consumed.status, consumed.text).toBe(200);
    expect(consumed.body.total).toBe(2); // 1 metered by the key auth + 1 consumed
    expect((await http.get("/v1/orgs/current/members").set(asKey)).status).toBe(403); // metered even when the route denies
    expect(await used(t.headers, "api_requests")).toBe(3);
    const audit = await pool.query(`SELECT actor_type FROM audit_logs WHERE organization_id = $1 AND event_type = 'api_key.created'`, [t.orgId]);
    expect(audit.rows[0].actor_type).toBe("user");
    expect((await http.delete(`/v1/api-keys/${key.body.id}`).set(t.headers)).status).toBe(204);
    expect((await http.get("/v1/usage/summary").set(asKey)).status).toBe(401);
  });

  it("10 parallel consumes against a 3-slot limit never overshoot", async () => {
    const t = await makeTenant(h);
    const platform = await platformHeaders(h);
    const grant = await http.post(`/v1/admin/orgs/${t.orgId}/entitlements/grants`).set(platform).send({ feature_key: "limit:api_requests", source: "addon", limit_value: 3 });
    expect(grant.status).toBe(201);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => http.post("/v1/usage/consume").set(t.headers).send({ events: [{ metric: "api_requests", quantity: 1 }] })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 402)).toHaveLength(7);
    expect(await used(t.headers, "api_requests")).toBe(3);
    const hard = await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE organization_id = $1 AND event_type = 'usage.hard_limit_reached'`, [t.orgId]);
    expect(hard.rows[0].n).toBe(1);
  });

  it("feature gate: 403 feature_not_entitled with upgrade hints", async () => {
    const { EntitlementsService } = await import("../../src/entitlements/entitlements.service");
    const { Database } = await import("../../src/core/db/database");
    const { FeatureNotEntitledError } = await import("../../src/core/errors");
    const t = await makeTenant(h);
    const entitlements = h.app.get(EntitlementsService);
    const db = h.app.get(Database);
    await expect(db.transaction((tx) => entitlements.requireFeature(tx, t.orgId, "agents"))).rejects.toMatchObject({
      status: 403,
      title: "feature_not_entitled",
      extras: { feature: "agents", current_plan: "free", available_in: ["enterprise", "pro"], upgrade_url: "/dashboard/billing" },
    });
    await expect(db.transaction((tx) => entitlements.requireFeature(tx, t.orgId, "api_access"))).resolves.toMatchObject({ planKey: "free" });
    expect(new FeatureNotEntitledError("x").problemType).toBe("https://synapse-saas.dev/problems/feature_not_entitled");
  });
});
