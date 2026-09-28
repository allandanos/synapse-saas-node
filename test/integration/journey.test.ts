import "reflect-metadata";
import http from "node:http";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module";
import { SystemSeeder } from "../../src/authorization/system-seed";
import { SETTINGS, type Settings } from "../../src/core/config";
import { MigrationRunner } from "../../src/core/db/migrations";
import { PlatformAdminBootstrap } from "../../src/identity/platform-admin.bootstrap";
import { configureHttp } from "../../src/main";

/**
 * The auth → org → invite → accept → roles → suspend → API-key journey over
 * HTTP against a real Postgres. Needs SYNAPSE_TEST_DATABASE_URL (a scratch
 * database: every table is truncated first); skipped otherwise so `pnpm test`
 * stays green without a database. `pnpm test:db` sets the default.
 */
const TEST_DB = process.env.SYNAPSE_TEST_DATABASE_URL;

// Node >= 19 keeps sockets alive by default; one connection per request keeps the journey deterministic.
http.globalAgent = new http.Agent({ keepAlive: false });
const ADMIN_EMAIL = "operator@platform.example.com";
const ADMIN_PASSWORD = "operator-password-12345";
const PASSWORD = "conformance-password-12345";

const uid = (): string => Math.random().toString(16).slice(2, 10);

async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations') LOOP
      EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
    END LOOP; END $$;`);
}

describe.skipIf(!TEST_DB)("milestone 2 journey (real Postgres)", () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    process.env.SYNAPSE_DATABASE_URL = TEST_DB;
    process.env.SYNAPSE_BOOTSTRAP_ADMIN_EMAIL = ADMIN_EMAIL;
    process.env.SYNAPSE_BOOTSTRAP_ADMIN_PASSWORD = ADMIN_PASSWORD;
    process.env.SYNAPSE_TENANT_ISOLATION = process.env.SYNAPSE_TEST_TENANT_ISOLATION ?? "app";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureHttp(app, app.get<Settings>(SETTINGS));
    await app.get(MigrationRunner).run();
    pool = new Pool({ connectionString: TEST_DB, max: 2 });
    await truncateAll(pool);
    await app.get(SystemSeeder).seed();
    await app.get(PlatformAdminBootstrap).run();
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  async function register(label: string): Promise<{ email: string; access: string; refresh: string; userId: string }> {
    const email = `${label}-${uid()}@example.com`;
    const res = await http.post("/v1/auth/register").send({ email, password: PASSWORD, display_name: label });
    expect(res.status, res.text).toBe(201);
    return { email, access: res.body.tokens.access_token, refresh: res.body.tokens.refresh_token, userId: res.body.user.id };
  }

  it("runs the whole journey", async () => {
    // ── problem documents + request ids ────────────────────────────────────
    const missing = await http.get("/v1/auth/me").set("X-Request-Id", "req_client_1");
    expect(missing.status).toBe(401);
    expect(missing.headers["x-request-id"]).toBe("req_client_1");
    expect(missing.body).toMatchObject({ type: "https://synapse-saas.dev/problems/unauthorized", title: "unauthorized", status: 401, request_id: "req_client_1", instance: "/v1/auth/me" });

    const unknown = await http.get("/v1/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.body.type).toBe("https://synapse-saas.dev/problems/not_found");
    expect(unknown.body.request_id).toMatch(/^req_[0-9a-f]{16}$/);
    expect(unknown.headers["x-request-id"]).toBe(unknown.body.request_id);

    const wrongMethod = await http.put("/v1/orgs").set("Authorization", "Bearer nope").send({});
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body).toMatchObject({ type: "https://synapse-saas.dev/problems/method_not_allowed", title: "method not allowed", instance: "/v1/orgs" });
    expect(wrongMethod.headers.allow).toBe("GET, POST");

    const invalid = await http.post("/v1/auth/register").send({ email: "not-an-email", password: "x" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.title).toBe("validation failed");
    expect(invalid.body.errors.map((e: { loc: string[] }) => e.loc.join("."))).toEqual(
      expect.arrayContaining(["body.email", "body.password", "body.display_name"]),
    );

    const badJson = await http.post("/v1/auth/register").set("Content-Type", "application/json").send("{not json");
    expect(badJson.status).toBe(422);
    expect(badJson.body.errors[0].type).toBe("json_invalid");

    // ── identity ─────────────────────────────────────────────────────────────
    const owner = await register("owner");
    const dup = await http.post("/v1/auth/register").send({ email: owner.email, password: PASSWORD, display_name: "Dup" });
    expect(dup.status).toBe(409);
    expect(dup.body.title).toBe("email already registered");

    const badLogin = await http.post("/v1/auth/login").send({ email: owner.email, password: "wrong-password-1" });
    expect(badLogin.status).toBe(401);
    expect(badLogin.body.title).toBe("invalid credentials");

    const refreshed = await http.post("/v1/auth/refresh").send({ refresh_token: owner.refresh });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ token_type: "bearer", expires_in: 900 });
    expect(refreshed.headers["set-cookie"]?.[0]).toMatch(/^synapse_rt=.*HttpOnly/);
    // The rotated token is replayed within the grace window: opaque 401, no chain kill
    const replay = await http.post("/v1/auth/refresh").send({ refresh_token: owner.refresh });
    expect(replay.status).toBe(401);
    const bogus = await http.post("/v1/auth/refresh").send({ refresh_token: "bogus" });
    expect(bogus.status).toBe(401);

    const me = await http.get("/v1/auth/me").set("Authorization", `Bearer ${owner.access}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: owner.userId, email: owner.email, is_platform_admin: false, orgs: [] });

    // ── tenancy ──────────────────────────────────────────────────────────────
    const bearer = { Authorization: `Bearer ${owner.access}` };
    const slug = `org-${uid()}`;
    const org = await http.post("/v1/orgs").set(bearer).send({ name: "Acme", slug });
    expect(org.status, org.text).toBe(201);
    expect(org.body).toMatchObject({ slug, name: "Acme", status: "active", owner_user_id: owner.userId, settings: {} });
    const orgId: string = org.body.id;
    const headers = { ...bearer, "X-Org-Id": orgId };

    const taken = await http.post("/v1/orgs").set(bearer).send({ name: "Acme Two", slug });
    expect(taken.status).toBe(201);
    expect(taken.body.slug).toMatch(/^acme-two-[0-9a-f]{6}$/);
    const reserved = await http.post("/v1/orgs").set(bearer).send({ name: "Admin", slug: "admin" });
    expect(reserved.status).toBe(409);
    expect(reserved.body).toMatchObject({ title: "slug unavailable", slug: "admin" });

    const orgs = await http.get("/v1/orgs").set(bearer);
    expect(orgs.status).toBe(200);
    expect(orgs.body.meta).toEqual({ total: 2, limit: 100, offset: 0 });
    expect((await http.get("/v1/auth/me").set(bearer)).body.orgs[0]).toEqual({ id: orgId, slug, name: "Acme", role_keys: ["owner"] });

    expect((await http.get("/v1/orgs/current").set(headers)).body.id).toBe(orgId);
    expect((await http.get("/v1/orgs/current").set(bearer).set("X-Org-Slug", slug)).body.id).toBe(orgId);
    const noOrg = await http.get("/v1/orgs/current").set(bearer);
    expect(noOrg.status).toBe(404);
    expect((await http.get("/v1/orgs/current").set(bearer).set("X-Org-Id", "nope")).status).toBe(404);

    const switched = await http.post("/v1/auth/switch-org").set(bearer).send({ organization_id: orgId });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ token_type: "bearer", expires_in: 900 });
    // the org claim resolves the tenant without X-Org-Id
    expect((await http.get("/v1/orgs/current").set("Authorization", `Bearer ${switched.body.access_token}`)).body.id).toBe(orgId);

    const renamed = await http.patch("/v1/orgs/current").set(headers).send({ name: "Renamed", settings: { theme: "dark" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed", settings: { theme: "dark" } });

    // ── members + invites ────────────────────────────────────────────────────
    const members = await http.get("/v1/orgs/current/members").set(headers);
    expect(members.status).toBe(200);
    expect(members.body.meta.total).toBe(1);
    expect(members.body.data[0]).toMatchObject({ user_id: owner.userId, email: owner.email, status: "active", role_keys: ["owner"] });

    const invitee = await register("invitee");
    const invited = await http.post("/v1/orgs/current/members/invite").set(headers).send({ email: invitee.email, role_keys: ["developer"] });
    expect(invited.status, invited.text).toBe(201);
    expect(invited.body).toMatchObject({ status: "invited", invited_email: invitee.email, role_keys: ["developer"], user_id: null });
    expect(invited.text).not.toContain("invite_token");
    const membershipId: string = invited.body.id;

    const outbox = await pool.query(`SELECT event_type, audience, payload FROM outbox_events WHERE aggregate_id = $1`, [membershipId]);
    const byType = new Map(outbox.rows.map((r) => [r.event_type as string, r]));
    expect([...byType.keys()].sort()).toEqual(["member.invite_email", "member.invited"]);
    expect(byType.get("member.invited")).toMatchObject({ audience: "public" });
    expect(byType.get("member.invited")?.payload).not.toHaveProperty("invite_token");
    expect(byType.get("member.invite_email")).toMatchObject({ audience: "internal" });
    const inviteToken: string = byType.get("member.invite_email")?.payload.invite_token;
    expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const badInvite = await http.post("/v1/auth/accept-invite").set("Authorization", `Bearer ${invitee.access}`).send({ token: "not-a-token" });
    expect(badInvite.status).toBe(404);
    expect(badInvite.body.title).toBe("invite not found");
    const accepted = await http.post("/v1/auth/accept-invite").set("Authorization", `Bearer ${invitee.access}`).send({ token: inviteToken });
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.body).toEqual({ organization_id: orgId, status: "active" });
    const again = await http.post("/v1/auth/accept-invite").set("Authorization", `Bearer ${invitee.access}`).send({ token: inviteToken });
    expect(again.status).toBe(404);

    const inviteeHeaders = { Authorization: `Bearer ${invitee.access}`, "X-Org-Id": orgId };
    expect((await http.get("/v1/orgs/current/members").set(headers)).body.meta.total).toBe(2);
    const denied = await http.post("/v1/orgs/current/members/invite").set(inviteeHeaders).send({ email: "x@example.com" });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ title: "permission denied", permission: "member:invite" });

    const promoted = await http.patch(`/v1/memberships/${membershipId}`).set(headers).send({ role_keys: ["admin"] });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role_keys).toEqual(["admin"]);
    expect((await http.post("/v1/orgs/current/members/invite").set(inviteeHeaders).send({ email: `y-${uid()}@example.com` })).status).toBe(201);

    const stranger = await register("stranger");
    const foreign = await http.patch(`/v1/memberships/${membershipId}`).set({ Authorization: `Bearer ${stranger.access}`, "X-Org-Id": orgId }).send({ role_keys: ["member"] });
    expect(foreign.status).toBe(404);

    // ── roles ────────────────────────────────────────────────────────────────
    const perms = await http.get("/v1/permissions");
    expect(perms.status).toBe(200);
    expect(perms.body).toHaveLength(21);
    const roles = await http.get("/v1/roles").set(headers);
    expect(roles.body.map((r: { key: string }) => r.key)).toEqual(["admin", "billing", "developer", "member", "owner"]);

    const role = await http.post("/v1/roles").set(headers).send({ key: "auditor", name: "Auditor", permissions: ["audit:read", "org:read"] });
    expect(role.status, role.text).toBe(201);
    expect(role.body).toMatchObject({ key: "auditor", is_system: false, permissions: ["audit:read", "org:read"] });
    const unknownPerm = await http.post("/v1/roles").set(headers).send({ key: "xx", name: "Xx", permissions: ["nope:nope"] });
    expect(unknownPerm.status).toBe(403);
    expect(unknownPerm.body.unknown).toEqual(["nope:nope"]);
    expect((await http.post("/v1/roles").set(headers).send({ key: "Bad Key", name: "Xx", permissions: [] })).status).toBe(422);
    const patched = await http.patch(`/v1/roles/${role.body.id}`).set(headers).send({ permissions: ["org:read"], name: "Reader" });
    expect(patched.body).toMatchObject({ name: "Reader", permissions: ["org:read"] });
    const ownerRole = roles.body.find((r: { key: string }) => r.key === "owner");
    expect((await http.delete(`/v1/roles/${ownerRole.id}`).set(headers)).status).toBe(404);
    expect((await http.delete(`/v1/roles/${role.body.id}`).set(headers)).status).toBe(204);
    expect((await http.delete(`/v1/roles/${role.body.id}`).set(headers)).status).toBe(404);

    // ── API keys ─────────────────────────────────────────────────────────────
    const key = await http.post("/v1/api-keys").set(headers).send({ name: "ci", scopes: ["org:read"] });
    expect(key.status, key.text).toBe(201);
    expect(key.body.key).toMatch(/^sk_/);
    const listed = await http.get("/v1/api-keys").set(headers);
    expect(listed.headers["x-total-count"]).toBe("1");
    expect(listed.body[0]).not.toHaveProperty("key");
    const asKey = { Authorization: `Bearer ${key.body.key}` };
    expect((await http.get("/v1/orgs/current").set(asKey)).body.id).toBe(orgId);
    const outOfScope = await http.get("/v1/orgs/current/members").set(asKey);
    expect(outOfScope.status).toBe(403);
    expect(outOfScope.body).toMatchObject({ auth: "api_key", permission: "member:read" });
    const escalate = await http.post("/v1/api-keys").set(inviteeHeaders).send({ name: "x", scopes: ["nope:nope"] });
    expect(escalate.status).toBe(403);
    const snapshot = await http.post("/v1/api-keys").set(headers).send({ name: "full" });
    expect(snapshot.body.scopes).toHaveLength(20);

    // ── operator suspension (ADR 0008) ───────────────────────────────────────
    expect((await http.post(`/v1/orgs/${orgId}/suspend`).set(headers)).status).toBe(404);
    const login = await http.post("/v1/auth/login").send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(login.status, login.text).toBe(200);
    expect(login.body.user.is_platform_admin).toBe(true);
    const platform = { Authorization: `Bearer ${login.body.tokens.access_token}` };
    expect((await http.post(`/v1/orgs/${orgId}/suspend`).set(platform)).status).toBe(204);
    const suspended = await http.get("/v1/orgs/current").set(headers);
    expect(suspended.status).toBe(403);
    expect(suspended.body).toMatchObject({ title: "organization suspended", organization_id: orgId, organization_status: "suspended" });
    expect((await http.get("/v1/orgs/current").set(asKey)).status).toBe(401);
    expect((await http.get("/v1/orgs/current").set({ ...platform, "X-Org-Id": orgId })).status).toBe(200);
    expect((await http.delete(`/v1/orgs/${orgId}/suspend`).set(platform)).status).toBe(204);
    expect((await http.get("/v1/orgs/current").set(headers)).status).toBe(200);

    expect((await http.delete(`/v1/api-keys/${key.body.id}`).set(headers)).status).toBe(204);
    expect((await http.get("/v1/orgs/current").set(asKey)).status).toBe(401);

    // ── password reset + logout ──────────────────────────────────────────────
    expect((await http.post("/v1/auth/forgot-password").send({ email: `nobody-${uid()}@example.com` })).status).toBe(202);
    expect((await http.post("/v1/auth/forgot-password").send({ email: owner.email })).status).toBe(202);
    const reset = await pool.query(`SELECT payload->>'token' AS token, audience FROM outbox_events WHERE event_type = 'user.password_reset_link' ORDER BY created_at DESC LIMIT 1`);
    expect(reset.rows[0].audience).toBe("internal");
    expect((await http.post("/v1/auth/reset-password").send({ token: "not-a-token", password: PASSWORD })).status).toBe(401);
    const resetOk = await http.post("/v1/auth/reset-password").send({ token: reset.rows[0].token, password: "brand-new-password-1" });
    expect(resetOk.status).toBe(200);
    expect((await http.post("/v1/auth/login").send({ email: owner.email, password: "brand-new-password-1" })).status).toBe(200);
    // sessions died on password change
    expect((await http.post("/v1/auth/refresh").send({ refresh_token: refreshed.body.refresh_token })).status).toBe(401);

    const logout = await http.post("/v1/auth/logout").set("Cookie", `synapse_rt=${resetOk.body.tokens.refresh_token}`);
    expect(logout.status).toBe(204);
    expect((await http.post("/v1/auth/refresh").send({ refresh_token: resetOk.body.tokens.refresh_token })).status).toBe(401);

    // ── member removal ───────────────────────────────────────────────────────
    const ownerMembership = members.body.data[0].id;
    const removeOwner = await http.delete(`/v1/memberships/${ownerMembership}`).set({ Authorization: `Bearer ${resetOk.body.tokens.access_token}`, "X-Org-Id": orgId });
    expect(removeOwner.status).toBe(404);
    const newHeaders = { Authorization: `Bearer ${resetOk.body.tokens.access_token}`, "X-Org-Id": orgId };
    expect((await http.delete(`/v1/memberships/${membershipId}`).set(newHeaders)).status).toBe(204);
    expect((await http.delete(`/v1/memberships/${membershipId}`).set(newHeaders)).status).toBe(404);

    const audit = await pool.query(`SELECT DISTINCT event_type FROM audit_logs WHERE organization_id = $1`, [orgId]);
    expect(audit.rows.map((r) => r.event_type).sort()).toEqual(
      expect.arrayContaining(["org.created", "org.updated", "member.invited", "member.joined", "member.updated", "member.removed", "api_key.created", "api_key.revoked", "org.suspended", "org.unsuspended"]),
    );
  });
});
