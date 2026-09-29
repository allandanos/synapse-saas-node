import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fernetDecrypt } from "../../src/webhooks/fernet";
import { DEV_SECRET_KEY } from "../../src/core/config";
import { JobsService } from "../../src/worker/jobs.service";
import {
  type Harness,
  makeTenant,
  platformHeaders,
  startHarness,
  stopHarness,
  type TenantFixture,
  TEST_DB,
  uid,
} from "./harness";

/**
 * Milestone-5 journeys against a real database: outbound webhook management,
 * file storage on the local-disk backend, feature flags, the audit read and
 * the agent registry. `test/integration/storage-s3.test.ts` covers the same
 * file routes on an S3-capable backend.
 */
const maybe = TEST_DB ? describe : describe.skip;

/** The free plan's `storage_bytes` cap — the gauge is driven up to it to prove the 402. */
const FREE_STORAGE_LIMIT = 1_073_741_824;

maybe("platform journeys (webhooks, files, flags, audit, agents)", () => {
  let h: Harness;
  let jobs: JobsService;
  let tenant: TenantFixture;
  let platform: { Authorization: string };

  beforeAll(async () => {
    h = await startHarness();
    jobs = h.app.get(JobsService);
    platform = await platformHeaders(h);
    tenant = await makeTenant(h);
  });

  afterAll(async () => {
    await stopHarness(h);
  });

  // ── Webhooks ────────────────────────────────────────────────────────────────

  describe("webhook endpoints and deliveries", () => {
    it("shows the secret once, stores it encrypted, and never lists it", async () => {
      const created = await h.http
        .post("/v1/webhooks/endpoints")
        .set(tenant.headers)
        .send({ url: "https://hooks.example.com/secret-once", events: ["member.invited"], description: "c" });
      expect(created.status, created.text).toBe(201);
      expect(created.body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);

      const stored = await h.pool.query<{ secret_encrypted: Buffer }>("SELECT secret_encrypted FROM webhook_endpoints WHERE id = $1", [created.body.id]);
      expect(stored.rows[0]?.secret_encrypted.toString("utf8")).not.toContain(created.body.secret);
      expect(fernetDecrypt(stored.rows[0]?.secret_encrypted as Buffer, DEV_SECRET_KEY)).toBe(created.body.secret);

      const listed = await h.http.get("/v1/webhooks/endpoints").set(tenant.headers);
      expect(listed.status).toBe(200);
      expect(listed.headers["x-total-count"]).toBe("1");
      expect(listed.body[0].secret).toBeUndefined();
      expect(listed.body[0].url).toBe("https://hooks.example.com/secret-once");

      const auditCreated = await h.http.get("/v1/audit").set(tenant.headers).query({ event_type: "webhook.endpoint_created" });
      expect(auditCreated.body.data.map((r: { target_id: string }) => r.target_id)).toEqual([created.body.id]);
      expect(auditCreated.body.data[0]).toMatchObject({ target_type: "webhook_endpoint" });
      expect(auditCreated.body.data[0].diff).toEqual({
        endpoint_id: created.body.id,
        url: "https://hooks.example.com/secret-once",
        events: ["member.invited"],
      });
      // The secret must not reach the outbox payload or the audit diff.
      expect(JSON.stringify(auditCreated.body)).not.toContain(created.body.secret);
      const emitted = await h.pool.query<{ event_type: string; payload: Record<string, unknown> }>(
        "SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1",
        [created.body.id],
      );
      expect(emitted.rows.map((r) => r.event_type)).toEqual(["webhook.endpoint_created"]);
      expect(JSON.stringify(emitted.rows[0]?.payload)).not.toContain(created.body.secret);

      await h.http.delete(`/v1/webhooks/endpoints/${created.body.id}`).set(tenant.headers).expect(204);
      const auditDeleted = await h.http.get("/v1/audit").set(tenant.headers).query({ event_type: "webhook.endpoint_deleted" });
      expect(auditDeleted.body.data.map((r: { target_id: string }) => r.target_id)).toEqual([created.body.id]);
      // The endpoint row is gone but its history is not.
      const after = await h.pool.query("SELECT event_type FROM outbox_events WHERE aggregate_id = $1", [created.body.id]);
      expect(after.rowCount).toBe(2);
    });

    it("refuses a url pydantic's HttpUrl would refuse", async () => {
      const bad = await h.http.post("/v1/webhooks/endpoints").set(tenant.headers).send({ url: "not a url", events: [] });
      expect(bad.status).toBe(422);
      expect(bad.body.type).toContain("validation_failed");
    });

    it("produces a delivery from a real event, filters it, retries it, and drops it with the endpoint", async () => {
      const subscriber = await makeTenant(h, "hooks");
      const endpoint = await h.http
        .post("/v1/webhooks/endpoints")
        .set(subscriber.headers)
        .send({ url: "https://hooks.example.com/all", events: [] }); // empty ⇒ every public event
      expect(endpoint.status, endpoint.text).toBe(201);

      // A real mutation: the invite emits `member.invited`, which the outbox
      // fans out to the org's active endpoints.
      const invited = await h.http
        .post("/v1/orgs/current/members/invite")
        .set(subscriber.headers)
        .send({ email: `guest-${uid()}@example.com` });
      expect(invited.status, invited.text).toBe(201);
      for (let i = 0; i < 20 && (await jobs.dispatchOutbox()) > 0; i += 1);

      const deliveries = await h.http.get("/v1/webhooks/deliveries").set(subscriber.headers).query({ endpoint_id: endpoint.body.id });
      expect(deliveries.status, deliveries.text).toBe(200);
      expect(deliveries.body.length).toBeGreaterThan(0);
      expect(deliveries.body.every((d: { endpoint_id: string }) => d.endpoint_id === endpoint.body.id)).toBe(true);
      expect(deliveries.body.map((d: { event_type: string }) => d.event_type)).toContain("member.invited");
      expect(Number(deliveries.headers["x-total-count"])).toBe(deliveries.body.length);

      // Internal events (the invite token) never become deliveries.
      expect(deliveries.body.map((d: { event_type: string }) => d.event_type)).not.toContain("member.invite_email");

      // An unrelated endpoint's filter sees none of them.
      const other = await h.http.post("/v1/webhooks/endpoints").set(subscriber.headers).send({ url: "https://hooks.example.com/other", events: [] });
      const empty = await h.http.get("/v1/webhooks/deliveries").set(subscriber.headers).query({ endpoint_id: other.body.id });
      expect(empty.body).toEqual([]);

      // Drain it so retry has something already attempted to reset.
      await jobs.deliverWebhooks();
      const deliveryId = deliveries.body[0].id;
      const retried = await h.http.post(`/v1/webhooks/deliveries/${deliveryId}/retry`).set(subscriber.headers);
      expect(retried.status, retried.text).toBe(200);
      expect(retried.body.status).toBe("pending");
      expect(retried.body.attempts).toBe(0);

      // Retrying an endpoint id is a delivery 404, not an endpoint one.
      const wrong = await h.http.post(`/v1/webhooks/deliveries/${endpoint.body.id}/retry`).set(subscriber.headers);
      expect(wrong.status).toBe(404);
      expect(wrong.body.type).toContain("webhook_delivery_not_found");

      await h.http.delete(`/v1/webhooks/endpoints/${endpoint.body.id}`).set(subscriber.headers).expect(204);
      const gone = await h.http.delete(`/v1/webhooks/endpoints/${endpoint.body.id}`).set(subscriber.headers);
      expect(gone.status).toBe(404);
      expect(gone.body.type).toContain("webhook_endpoint_not_found");
      const cascaded = await h.pool.query("SELECT 1 FROM webhook_deliveries WHERE endpoint_id = $1", [endpoint.body.id]);
      expect(cascaded.rowCount).toBe(0);
    });

    it("orders the endpoint list newest first so pages never repeat a row", async () => {
      const lister = await makeTenant(h, "hook-order");
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const made = await h.http.post("/v1/webhooks/endpoints").set(lister.headers).send({ url: `https://hooks.example.com/n${String(i)}`, events: [] });
        expect(made.status, made.text).toBe(201);
        ids.push(made.body.id);
      }
      const listed = await h.http.get("/v1/webhooks/endpoints").set(lister.headers);
      expect(listed.headers["x-total-count"]).toBe("3");
      const order = listed.body.map((e: { id: string }) => e.id);
      // `created_at` desc, id — the same rows and the same order every time.
      expect(new Set(order)).toEqual(new Set(ids));
      expect((await h.http.get("/v1/webhooks/endpoints").set(lister.headers)).body.map((e: { id: string }) => e.id)).toEqual(order);
      const firstPage = await h.http.get("/v1/webhooks/endpoints").set(lister.headers).query({ limit: 2, offset: 0 });
      const secondPage = await h.http.get("/v1/webhooks/endpoints").set(lister.headers).query({ limit: 2, offset: 2 });
      expect([...firstPage.body, ...secondPage.body].map((e: { id: string }) => e.id)).toEqual(order);
    });

    it("is invisible across tenants", async () => {
      const mine = await h.http.post("/v1/webhooks/endpoints").set(tenant.headers).send({ url: "https://hooks.example.com/mine", events: [] });
      const stranger = await makeTenant(h, "stranger");
      const peek = await h.http.delete(`/v1/webhooks/endpoints/${mine.body.id}`).set(stranger.headers);
      expect(peek.status).toBe(404);
      await h.http.delete(`/v1/webhooks/endpoints/${mine.body.id}`).set(tenant.headers).expect(204);
    });
  });

  // ── Files ───────────────────────────────────────────────────────────────────

  describe("file storage on local disk", () => {
    it("uploads, lists, downloads, moves the gauge, and gives the bytes back on delete", async () => {
      const files = await makeTenant(h, "files");
      const uploaded = await h.http.post("/v1/files").set(files.headers).attach("file", Buffer.from("hello"), { filename: "a.txt", contentType: "text/plain" });
      expect(uploaded.status, uploaded.text).toBe(201);
      expect(uploaded.body).toMatchObject({ name: "a.txt", content_type: "text/plain", size_bytes: 5, status: "ready" });
      expect(uploaded.body.key).toBe(`${files.orgId}/a.txt`);

      const listed = await h.http.get("/v1/files").set(files.headers);
      expect(listed.status).toBe(200);
      expect(listed.body.map((f: { id: string }) => f.id)).toEqual([uploaded.body.id]);
      expect(listed.headers["x-total-count"]).toBe("1");

      const downloaded = await h.http.get(`/v1/files/${uploaded.body.id}`).set(files.headers).responseType("blob");
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(downloaded.body as Buffer).toString("utf8")).toBe("hello");
      expect(downloaded.headers["content-type"]).toContain("text/plain");
      expect(downloaded.headers["content-disposition"]).toBe('attachment; filename="a.txt"');

      const auditUploaded = await h.http.get("/v1/audit").set(files.headers).query({ event_type: "file.uploaded" });
      expect(auditUploaded.body.data.map((r: { target_id: string }) => r.target_id)).toEqual([uploaded.body.id]);
      expect(auditUploaded.body.data[0]).toMatchObject({ target_type: "file" });
      expect(auditUploaded.body.data[0].diff).toEqual({ file_id: uploaded.body.id, name: "a.txt", content_type: "text/plain", size_bytes: 5 });

      expect(await storageUsed(files)).toBe(5);
      await h.http.delete(`/v1/files/${uploaded.body.id}`).set(files.headers).expect(204);
      const auditDeleted = await h.http.get("/v1/audit").set(files.headers).query({ event_type: "file.deleted" });
      expect(auditDeleted.body.data.map((r: { target_id: string }) => r.target_id)).toEqual([uploaded.body.id]);
      const emitted = await h.pool.query<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at", [
        uploaded.body.id,
      ]);
      expect(emitted.rows.map((r) => r.event_type)).toEqual(["file.uploaded", "file.deleted"]);

      expect(await storageUsed(files)).toBe(0);
      expect((await h.http.get(`/v1/files/${uploaded.body.id}`).set(files.headers)).status).toBe(404);
      expect((await h.http.get("/v1/files").set(files.headers)).body).toEqual([]);
    });

    it("refuses an upload that would breach the quota before writing a byte", async () => {
      const files = await makeTenant(h, "quota");
      await h.http.post("/v1/usage/gauge").set(files.headers).send({ metric: "storage_bytes", value: FREE_STORAGE_LIMIT }).expect(200);
      const blocked = await h.http.post("/v1/files").set(files.headers).attach("file", Buffer.from("hello"), { filename: "b.txt", contentType: "text/plain" });
      expect(blocked.status, blocked.text).toBe(402);
      expect(blocked.body).toMatchObject({ metric: "storage_bytes", limit: FREE_STORAGE_LIMIT });
      expect(blocked.body.upgrade_url).toBeTruthy();
      // Nothing was indexed and the level did not move.
      expect((await h.http.get("/v1/files").set(files.headers)).body).toEqual([]);
      expect(await storageUsed(files)).toBe(FREE_STORAGE_LIMIT);
      // No row, so no event and no audit trail either.
      expect((await h.http.get("/v1/audit").set(files.headers).query({ event_type: "file.uploaded" })).body.data).toEqual([]);
    });

    it("refuses both presign directions with direct_upload_limit_bytes on the upload one", async () => {
      const files = await makeTenant(h, "presign");
      const upload = await h.http
        .post("/v1/files/presign-upload")
        .set(files.headers)
        .send({ name: "big.bin", size_bytes: 1024, content_type: "application/octet-stream" });
      expect(upload.status, upload.text).toBe(409);
      expect(upload.body.type).toContain("presign_unsupported");
      expect(upload.body.direct_upload_limit_bytes).toBe(10 * 1024 * 1024);

      const stored = await h.http.post("/v1/files").set(files.headers).attach("file", Buffer.from("x"), { filename: "c.txt", contentType: "text/plain" });
      const download = await h.http.post(`/v1/files/${stored.body.id}/presign`).set(files.headers);
      expect(download.status).toBe(409);
      expect(download.body.type).toContain("presign_unsupported");
    });

    it("answers a missing part, a non-multipart body and an oversized upload with storage_error", async () => {
      const files = await makeTenant(h, "bad-upload");
      const noPart = await h.http.post("/v1/files").set(files.headers).attach("wrong", Buffer.from("x"), { filename: "x.txt" });
      expect(noPart.status).toBe(400);
      expect(noPart.body.type).toContain("storage_error");

      const notMultipart = await h.http.post("/v1/files").set(files.headers).send({ file: "x" });
      expect(notMultipart.status).toBe(400);
      expect(notMultipart.body.type).toContain("storage_error");

      const tooBig = await h.http
        .post("/v1/files")
        .set(files.headers)
        .attach("file", Buffer.alloc(11 * 1024 * 1024, 1), { filename: "big.bin", contentType: "application/octet-stream" });
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.type).toContain("storage_error");
      expect(await storageUsed(files)).toBe(0);
    });

    it("hides another tenant's file behind the same 404", async () => {
      const owner = await makeTenant(h, "owner-files");
      const stranger = await makeTenant(h, "stranger-files");
      const stored = await h.http.post("/v1/files").set(owner.headers).attach("file", Buffer.from("x"), { filename: "d.txt", contentType: "text/plain" });
      expect((await h.http.get(`/v1/files/${stored.body.id}`).set(stranger.headers)).status).toBe(404);
      expect((await h.http.delete(`/v1/files/${stored.body.id}`).set(stranger.headers)).status).toBe(404);
    });
  });

  // ── Feature flags ───────────────────────────────────────────────────────────

  describe("feature flags", () => {
    it("is off for an unknown flag and invisible to tenants", async () => {
      const off = await h.http.get(`/v1/feature-flags/check/never-defined-${uid()}`).set(tenant.headers);
      expect(off.status).toBe(200);
      expect(off.body.enabled).toBe(false);

      expect((await h.http.get("/v1/feature-flags").set(tenant.headers)).status).toBe(404);
      expect((await h.http.post("/v1/feature-flags").set(tenant.headers).send({ key: `k-${uid()}`, name: "n" })).status).toBe(404);
    });

    it("resolves user override over org override over the global default", async () => {
      const key = `layered-${uid()}`;
      await h.http.post("/v1/feature-flags").set(platform).send({ key, name: key, enabled: false }).expect(201);
      expect((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled).toBe(false);

      const orgOn = await h.http.post(`/v1/feature-flags/${key}/overrides`).set(platform).send({ organization_id: tenant.orgId, enabled: true, note: "org" });
      expect(orgOn.status, orgOn.text).toBe(201);
      expect((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled).toBe(true);

      const userOff = await h.http.post(`/v1/feature-flags/${key}/overrides`).set(platform).send({ user_id: tenant.userId, enabled: false, note: "user" });
      expect(userOff.status, userOff.text).toBe(201);
      expect((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled).toBe(false);

      const overrides = await h.http.get(`/v1/feature-flags/${key}/overrides`).set(platform);
      expect(overrides.body).toHaveLength(2);
      expect(overrides.headers["x-total-count"]).toBe("2");

      await h.http.delete(`/v1/feature-flags/overrides/${userOff.body.id}`).set(platform).expect(204);
      expect((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled).toBe(true);
      await h.http.delete(`/v1/feature-flags/overrides/${orgOn.body.id}`).set(platform).expect(204);
      expect((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled).toBe(false);

      const patched = await h.http.patch(`/v1/feature-flags/${key}`).set(platform).send({ enabled: true });
      expect(patched.status).toBe(200);
      expect((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled).toBe(true);
    });

    it("rewrites an existing scope instead of stacking overrides", async () => {
      const key = `upsert-${uid()}`;
      await h.http.post("/v1/feature-flags").set(platform).send({ key, name: key }).expect(201);
      const first = await h.http.post(`/v1/feature-flags/${key}/overrides`).set(platform).send({ organization_id: tenant.orgId, enabled: true });
      const second = await h.http.post(`/v1/feature-flags/${key}/overrides`).set(platform).send({ organization_id: tenant.orgId, enabled: false, note: "off" });
      expect(second.body.id).toBe(first.body.id);
      expect((await h.http.get(`/v1/feature-flags/${key}/overrides`).set(platform)).body).toHaveLength(1);
      expect((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled).toBe(false);
    });

    it("rejects a duplicate key, an unknown key and a scope-less override", async () => {
      const key = `dupe-${uid()}`;
      await h.http.post("/v1/feature-flags").set(platform).send({ key, name: key }).expect(201);
      const dupe = await h.http.post("/v1/feature-flags").set(platform).send({ key, name: key });
      expect(dupe.status).toBe(409);
      expect(dupe.body.key).toBe(key);

      const unknown = await h.http.patch(`/v1/feature-flags/missing-${uid()}`).set(platform).send({ enabled: true });
      expect(unknown.status).toBe(404);
      expect(unknown.body.type).toContain("feature_flag_not_found");

      const scopeless = await h.http.post(`/v1/feature-flags/${key}/overrides`).set(platform).send({ enabled: true });
      expect(scopeless.status).toBe(422);

      // Exactly one scope: both used to be stored silently as a user override.
      const bothScopes = await h.http
        .post(`/v1/feature-flags/${key}/overrides`)
        .set(platform)
        .send({ organization_id: tenant.orgId, user_id: tenant.userId, enabled: true });
      expect(bothScopes.status, bothScopes.text).toBe(422);
      expect(bothScopes.body.type).toContain("validation_failed");
      expect((await h.http.get(`/v1/feature-flags/${key}/overrides`).set(platform)).body).toEqual([]);
    });

    it("keeps a percentage rollout deterministic for the same identity", async () => {
      const key = `rollout-${uid()}`;
      await h.http.post("/v1/feature-flags").set(platform).send({ key, name: key, rollout_percentage: 100 }).expect(201);
      expect((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled).toBe(true);

      await h.http.patch(`/v1/feature-flags/${key}`).set(platform).send({ rollout_percentage: 0 }).expect(200);
      const answers = [];
      for (let i = 0; i < 5; i += 1) answers.push((await h.http.get(`/v1/feature-flags/check/${key}`).set(tenant.headers)).body.enabled);
      expect(answers).toEqual([false, false, false, false, false]);
    });
  });

  // ── Audit ───────────────────────────────────────────────────────────────────

  describe("audit log", () => {
    it("pages, filters and attributes an API-key action to the human who created the key", async () => {
      const actor = await makeTenant(h, "auditor");
      const key = await h.http.post("/v1/api-keys").set(actor.headers).send({ name: `k-${uid()}` });
      expect(key.status, key.text).toBe(201);

      const page = await h.http.get("/v1/audit").set(actor.headers).query({ limit: 5 });
      expect(page.status, page.text).toBe(200);
      expect(Object.keys(page.body).sort()).toEqual(["data", "next_cursor"]);
      expect(page.body.next_cursor).toBeNull();
      expect(page.body.data.length).toBeGreaterThan(0);
      expect(page.body.data.length).toBeLessThanOrEqual(5);
      expect(page.body.data[0]).toMatchObject({ event_type: expect.any(String), actor_type: "user" });
      expect(page.body.data[0].request_id).toBeTruthy();
      // Newest first.
      const times = page.body.data.map((r: { created_at: string }) => Date.parse(r.created_at));
      expect([...times].sort((a: number, b: number) => b - a)).toEqual(times);

      const filtered = await h.http.get("/v1/audit").set(actor.headers).query({ event_type: "api_key.created" });
      expect(filtered.body.data.every((r: { event_type: string }) => r.event_type === "api_key.created")).toBe(true);
      expect(filtered.body.data.length).toBe(1);

      const byActor = await h.http.get("/v1/audit").set(actor.headers).query({ actor_user_id: actor.userId });
      expect(byActor.body.data.length).toBeGreaterThan(0);

      // A key-authenticated mutation is attributed to the key's creator.
      const keyAuth = { Authorization: `Bearer ${key.body.key as string}` };
      const viaKey = await h.http.post("/v1/api-keys").set(keyAuth).send({ name: `child-${uid()}` });
      expect(viaKey.status, viaKey.text).toBe(201);
      const attributed = await h.http.get("/v1/audit").set(actor.headers).query({ event_type: "api_key.created", limit: 5 });
      const byKey = attributed.body.data.find((r: { actor_type: string }) => r.actor_type === "api_key");
      expect(byKey).toBeDefined();
      expect(byKey.actor_user_id).toBe(actor.userId);
      expect(byKey.diff.api_key_id).toBe(key.body.id);

      // Another tenant's rows are never in this page.
      const stranger = await makeTenant(h, "audit-stranger");
      const theirs = await h.http.get("/v1/audit").set(stranger.headers);
      expect(theirs.body.data.every((r: { organization_id: string }) => r.organization_id === stranger.orgId)).toBe(true);
    });

    it("validates limit and offset", async () => {
      expect((await h.http.get("/v1/audit").set(tenant.headers).query({ limit: 0 })).status).toBe(422);
      expect((await h.http.get("/v1/audit").set(tenant.headers).query({ limit: 101 })).status).toBe(422);
      expect((await h.http.get("/v1/audit").set(tenant.headers).query({ offset: -1 })).status).toBe(422);
      expect((await h.http.get("/v1/audit").set(tenant.headers).query({ actor_user_id: "nope" })).status).toBe(422);
    });
  });

  // ── Agents ──────────────────────────────────────────────────────────────────

  describe("agent registry", () => {
    it("is gated, then usable end to end once the feature is granted", async () => {
      const owner = await makeTenant(h, "agents");
      const gated = await h.http.get("/v1/agents").set(owner.headers);
      expect(gated.status).toBe(403);
      expect(gated.body).toMatchObject({ feature: "agents" });
      expect(Array.isArray(gated.body.available_in)).toBe(true);
      expect(gated.body.upgrade_url).toBeTruthy();

      await h.http
        .post(`/v1/admin/orgs/${owner.orgId}/entitlements/grants`)
        .set(platform)
        .send({ feature_key: "agents", source: "beta" })
        .expect(201);

      const slug = `bot-${uid()}`;
      const created = await h.http.post("/v1/agents").set(owner.headers).send({ slug, name: "Bot", config: { model: "x" } });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ slug, name: "Bot", status: "active", config: { model: "x" } });

      const dupe = await h.http.post("/v1/agents").set(owner.headers).send({ slug, name: "Bot" });
      expect(dupe.status).toBe(409);
      expect(dupe.body.slug).toBe(slug);

      const patched = await h.http.patch(`/v1/agents/${created.body.id}`).set(owner.headers).send({ name: "Bot 2", config: { model: "y" } });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: "Bot 2", config: { model: "y" } });

      expect((await h.http.post(`/v1/agents/${created.body.id}/disable`).set(owner.headers)).body.status).toBe("disabled");
      expect((await h.http.post(`/v1/agents/${created.body.id}/enable`).set(owner.headers)).body.status).toBe("active");

      const listed = await h.http.get("/v1/agents").set(owner.headers);
      expect(listed.body.map((a: { id: string }) => a.id)).toEqual([created.body.id]);
      expect(listed.headers["x-total-count"]).toBe("1");

      await h.http.delete(`/v1/agents/${created.body.id}`).set(owner.headers).expect(204);
      expect((await h.http.get(`/v1/agents/${created.body.id}`).set(owner.headers)).status).toBe(404);
      expect((await h.http.get("/v1/agents").set(owner.headers)).body).toEqual([]);

      // The slug stays taken: registry rows are billing history.
      const reused = await h.http.post("/v1/agents").set(owner.headers).send({ slug, name: "Bot again" });
      expect(reused.status).toBe(409);

      // Lifecycle events reached the outbox in the same transactions.
      const emitted = await h.pool.query<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at", [
        created.body.id,
      ]);
      expect(emitted.rows.map((r) => r.event_type)).toEqual([
        "agent.registered",
        "agent.updated",
        "agent.disabled",
        "agent.updated",
        "agent.disabled",
      ]);
      const audited = await h.pool.query<{ event_type: string }>("SELECT event_type FROM audit_logs WHERE target_id = $1 ORDER BY created_at", [
        created.body.id,
      ]);
      expect(audited.rows.map((r) => r.event_type)).toEqual([
        "agent.registered",
        "agent.updated",
        "agent.disabled",
        "agent.active",
        "agent.deleted",
      ]);
    });

    it("validates the slug and hides another tenant's agents", async () => {
      const owner = await makeTenant(h, "agents-b");
      await h.http.post(`/v1/admin/orgs/${owner.orgId}/entitlements/grants`).set(platform).send({ feature_key: "agents", source: "beta" }).expect(201);
      expect((await h.http.post("/v1/agents").set(owner.headers).send({ slug: "Bad Slug", name: "x" })).status).toBe(422);
      expect((await h.http.post("/v1/agents").set(owner.headers).send({ slug: "ok", name: "x" })).status).toBe(422); // name too short

      const mine = await h.http.post("/v1/agents").set(owner.headers).send({ slug: `mine-${uid()}`, name: "Mine" });
      const stranger = await makeTenant(h, "agents-stranger");
      await h.http
        .post(`/v1/admin/orgs/${stranger.orgId}/entitlements/grants`)
        .set(platform)
        .send({ feature_key: "agents", source: "beta" })
        .expect(201);
      expect((await h.http.get(`/v1/agents/${mine.body.id}`).set(stranger.headers)).status).toBe(404);
    });
  });

  async function storageUsed(who: TenantFixture): Promise<number> {
    const summary = await h.http.get("/v1/usage/summary").set(who.headers);
    const row = summary.body.metrics.find((m: { metric: string }) => m.metric === "storage_bytes");
    return row ? Number(row.used) : 0;
  }
});
