import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationService } from "../../src/authorization/authorization.service";
import { FgaClient, type FgaTuple } from "../../src/authorization/fga/client";
import { buildModel, relationFor, ROLE_ORDER } from "../../src/authorization/fga/model";
import { FgaSyncService, orgObject, userObject } from "../../src/authorization/fga/sync";
import { PERMISSIONS, SYSTEM_ROLES } from "../../src/authorization/permissions";
import { RolesRepository } from "../../src/authorization/roles.repository";
import { CACHE_BACKEND, CACHE_NAMESPACES, CacheRegistry } from "../../src/core/cache/cache.registry";
import type { CacheBackend } from "../../src/core/cache/backend";
import { loadSettings } from "../../src/core/config";
import { Database } from "../../src/core/db/database";
import { RequestContext } from "../../src/core/request-context";
import { JobsService } from "../../src/worker/jobs.service";
import { type Harness, makeTenant, PASSWORD, register, startHarness, stopHarness, TEST_DB, uid } from "./harness";

/** Accept a pending invite the way the console does: register, then POST the emailed token. */
async function inviteAndAccept(h: Harness, headers: Record<string, string>, label: string): Promise<{ membershipId: string; userId: string }> {
  const user = await register(h, label);
  const invited = await h.http.post("/v1/orgs/current/members/invite").set(headers).send({ email: user.email, role_keys: ["member"] });
  if (invited.status !== 201) throw new Error(`invite failed: ${invited.text}`);
  const outbox = await h.pool.query<{ payload: { invite_token: string } }>(
    `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'member.invite_email'`,
    [invited.body.id as string],
  );
  const token = outbox.rows[0]?.payload.invite_token;
  const accepted = await h.http.post("/v1/auth/accept-invite").set("Authorization", `Bearer ${user.access}`).send({ token });
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.text}`);
  return { membershipId: invited.body.id as string, userId: user.userId };
}

/**
 * Against a REAL OpenFGA (`docker compose --profile extras up -d openfga`, or
 * the shared local one) — the port of `tests/integration/test_openfga_parity.py`.
 *
 * 1. The generated model answers every system role × permission exactly like RBAC.
 * 2. With SYNAPSE_AUTHZ_BACKEND=openfga a route is gated by the store, and the
 *    tuple sync (outbox → worker consumer) converges after a role change.
 *
 * Every run creates its own store: the server is shared with other ports.
 */
const FGA_URL = process.env.SYNAPSE_OPENFGA_URL ?? "";
const RUN = Boolean(TEST_DB && FGA_URL);

describe.skipIf(!RUN)("OpenFGA parity (real store)", () => {
  let store: FgaClient;
  let h: Harness;
  const previous = { backend: process.env.SYNAPSE_AUTHZ_BACKEND, storeId: process.env.SYNAPSE_OPENFGA_STORE_ID, modelId: process.env.SYNAPSE_OPENFGA_MODEL_ID };

  beforeAll(async () => {
    const bootstrap = new FgaClient(loadSettings({ SYNAPSE_OPENFGA_URL: FGA_URL, SYNAPSE_OPENFGA_STORE_ID: "" }));
    bootstrap.storeId = await bootstrap.createStore(`synapse-node-test-${uid()}`);
    bootstrap.modelId = await bootstrap.writeModel(buildModel());
    store = bootstrap;
    process.env.SYNAPSE_AUTHZ_BACKEND = "openfga";
    process.env.SYNAPSE_OPENFGA_STORE_ID = bootstrap.storeId;
    process.env.SYNAPSE_OPENFGA_MODEL_ID = bootstrap.modelId;
    h = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(h);
    process.env.SYNAPSE_AUTHZ_BACKEND = previous.backend ?? "rbac";
    process.env.SYNAPSE_OPENFGA_STORE_ID = previous.storeId ?? "";
    process.env.SYNAPSE_OPENFGA_MODEL_ID = previous.modelId ?? "";
  });

  describe("model parity", () => {
    it("answers every role × permission exactly like RBAC", async () => {
      const org = orgObject(randomUUID());
      const users: Record<string, string> = {};
      const writes: FgaTuple[] = [];
      for (const role of ROLE_ORDER) {
        users[role] = userObject(randomUUID());
        writes.push({ user: users[role] as string, relation: role, object: org });
      }
      await store.write(writes);

      const mismatches: [string, string, boolean][] = [];
      for (const role of ROLE_ORDER) {
        const granted = new Set(SYSTEM_ROLES[role]?.permissions ?? []);
        for (const permission of PERMISSIONS) {
          const allowed = await store.check(users[role] as string, relationFor(permission.key), org);
          if (allowed !== granted.has(permission.key)) mismatches.push([role, permission.key, allowed]);
        }
      }
      expect(mismatches).toEqual([]);
    }, 120_000);

    it("carries direct grants, project inheritance and explicit sharing", async () => {
      const org = orgObject(randomUUID());
      const user = userObject(randomUUID());
      const project = `project:${randomUUID()}`;
      await store.write([
        { user, relation: "member", object: org }, // member: project:read only
        { user, relation: "can_audit_read", object: org }, // a custom role's direct grant
        { user: org, relation: "org", object: project },
      ]);
      expect(await store.check(user, "can_audit_read", org)).toBe(true);
      expect(await store.check(user, "viewer", project)).toBe(true); // inherited via can_project_read from org
      expect(await store.check(user, "editor", project)).toBe(false);
      await store.write([{ user, relation: "editor", object: project }]); // shared explicitly
      expect(await store.check(user, "editor", project)).toBe(true);
    });
  });

  describe("routes are gated by the store", () => {
    it("gates on the store, and converges on a role change", async () => {
      const tenant = await makeTenant(h, "fga-owner");
      const cache = h.app.get(CacheRegistry).namespace(CACHE_NAMESPACES.FGA);
      const org = orgObject(tenant.orgId);
      const ownerUser = userObject(tenant.userId);

      // Creating the org synced the owner's tuple, so the very next request works.
      // (The reference syncs nothing here and denies its own owner — see the plan.)
      expect(await store.check(ownerUser, "can_member_read", org)).toBe(true);
      const allowed = await h.http.get("/v1/orgs/current/members").set(tenant.headers);
      expect(allowed.status, allowed.text).toBe(200);

      // Take the tuple away behind the API's back: the store, not RBAC, decides
      await store.write([], [{ user: ownerUser, relation: "owner", object: org }]);
      await cache.bump(`${tenant.userId}:${org}`);
      const denied = await h.http.get("/v1/orgs/current/members").set(tenant.headers);
      expect(denied.status, denied.text).toBe(403);

      // Put it back the way `pnpm authz:fga sync --all` does
      const result = await h.app.get(FgaSyncService).apply(tenant.orgId, tenant.userId);
      expect(result.writes).toBeGreaterThanOrEqual(1);
      await cache.bump(`${tenant.userId}:${org}`);
      expect((await h.http.get("/v1/orgs/current/members").set(tenant.headers)).status).toBe(200);

      // A membership change queues a resync; the worker consumer applies it
      const dev = await inviteAndAccept(h, tenant.headers, "fga-dev");
      await h.app.get(JobsService).dispatchOutbox();

      const devUser = userObject(dev.userId);
      expect(await store.check(devUser, "member", org)).toBe(true);
      expect(await store.check(devUser, "can_org_delete", org)).toBe(false);

      // Promote to admin ⇒ resync ⇒ the store swaps the role tuple
      const patched = await h.http.patch(`/v1/memberships/${dev.membershipId}`).set(tenant.headers).send({ role_keys: ["admin"] });
      expect(patched.status, patched.text).toBe(200);
      await h.app.get(JobsService).dispatchOutbox();
      expect(await store.check(devUser, "admin", org)).toBe(true);
      expect(await store.check(devUser, "member", org)).toBe(false);

      // And nothing dead-lettered along the way
      const dead = await h.pool.query<{ count: string }>("SELECT count(*) FROM outbox_events WHERE dead_at IS NOT NULL");
      expect(Number(dead.rows[0]?.count ?? 0)).toBe(0);
    }, 120_000);

    it("a custom-role edit resyncs every holder's direct grants", async () => {
      const tenant = await makeTenant(h, "fga-roles");
      const sync = h.app.get(FgaSyncService);
      await sync.apply(tenant.orgId, tenant.userId);
      const org = orgObject(tenant.orgId);
      const owner = userObject(tenant.userId);
      expect(await store.check(owner, "owner", org)).toBe(true);

      // A second member holding `member` plus a custom role granting audit:read.
      const member = await inviteAndAccept(h, tenant.headers, "fga-auditor");
      const role = await h.http.post("/v1/roles").set(tenant.headers).send({ key: `auditor_${uid()}`, name: "Auditor", permissions: ["audit:read"] });
      expect(role.status, role.text).toBe(201);
      const patched = await h.http
        .patch(`/v1/memberships/${member.membershipId}`)
        .set(tenant.headers)
        .send({ role_keys: ["member", role.body.key as string] });
      expect(patched.status, patched.text).toBe(200);
      await h.app.get(JobsService).dispatchOutbox();

      const auditor = userObject(member.userId);
      expect(await store.check(auditor, "member", org)).toBe(true);
      expect(await store.check(auditor, "can_audit_read", org)).toBe(true);

      // Drop the permission from the role: every holder loses the direct grant
      const updated = await h.http.patch(`/v1/roles/${role.body.id as string}`).set(tenant.headers).send({ permissions: ["usage:read"] });
      expect(updated.status, updated.text).toBe(200);
      await h.app.get(JobsService).dispatchOutbox();
      expect(await store.check(auditor, "can_audit_read", org)).toBe(false);
      expect(await store.check(auditor, "can_usage_read", org)).toBe(true);
    }, 120_000);

    it("an API key answers from its scopes and never consults the store", async () => {
      const tenant = await makeTenant(h, "fga-key");
      const sync = h.app.get(FgaSyncService);
      await sync.apply(tenant.orgId, tenant.userId);
      await h.app.get(CacheRegistry).namespace(CACHE_NAMESPACES.FGA).bump(`${tenant.userId}:${orgObject(tenant.orgId)}`);
      const key = await h.http.post("/v1/api-keys").set(tenant.headers).send({ name: "ci", scopes: ["org:read"] });
      expect(key.status, key.text).toBe(201);

      // An API key's authority is its scopes ∩ the creator's RBAC, so the
      // store is never asked — even under the openfga backend.
      const keyAuth = { Authorization: `Bearer ${key.body.key as string}` };
      const ok = await h.http.get("/v1/orgs/current").set(keyAuth);
      expect(ok.status, ok.text).toBe(200);
      const denied = await h.http.get("/v1/orgs/current/members").set(keyAuth);
      expect(denied.status).toBe(403);
      expect(denied.body.auth).toBe("api_key");
    });
  });

  describe("fail modes", () => {
    it("closed denies and rbac falls back when the store is unreachable", async () => {
      const dead = { SYNAPSE_OPENFGA_URL: "http://127.0.0.1:1", SYNAPSE_OPENFGA_STORE_ID: "st", SYNAPSE_AUTHZ_BACKEND: "openfga" };
      const tenant = await makeTenant(h, "fga-outage");
      const roles = h.app.get(AuthorizationService);
      expect(await roles.permissionKeysFor(tenant.userId, tenant.orgId)).toContain("org:read");

      const backend = h.app.get<CacheBackend>(CACHE_BACKEND);
      for (const [mode, expected] of [
        ["closed", false],
        ["rbac", true],
      ] as const) {
        const service = new AuthorizationService(
          h.app.get(Database),
          h.app.get(RolesRepository),
          h.app.get(RequestContext),
          h.app.get(FgaSyncService),
          new CacheRegistry(backend), // a fresh registry: no decision cached from another mode
          loadSettings({ ...dead, SYNAPSE_OPENFGA_FAIL_MODE: mode, SYNAPSE_DATABASE_URL: TEST_DB }),
        );
        expect(await service.userCan(tenant.userId, tenant.orgId, "org:read"), mode).toBe(expected);
      }
    }, 60_000);
  });
});
