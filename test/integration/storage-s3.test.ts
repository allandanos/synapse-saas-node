import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StubS3Server } from "../support/stub-s3-server";
import { type Harness, makeTenant, startHarness, stopHarness, type TenantFixture, TEST_DB } from "./harness";

/**
 * The presigned-upload half of `/v1/files`, which only exists on an
 * S3-capable backend. MinIO's image is not pullable here, so the backend is
 * pointed at `StubS3Server` — an S3-shaped object store over plain HTTP. The
 * AWS SDK's SigV4 is not re-tested; what is under test is the route
 * choreography: reserve → presign → PUT → complete, and the release when the
 * bytes never arrive.
 */
const maybe = TEST_DB ? describe : describe.skip;

const BUCKET = "synapse-node-test";

maybe("file storage on an S3-compatible backend", () => {
  const stub = new StubS3Server(BUCKET);
  let h: Harness;
  let tenant: TenantFixture;

  beforeAll(async () => {
    const endpoint = await stub.start();
    process.env.SYNAPSE_S3_BUCKET = BUCKET;
    process.env.SYNAPSE_S3_ENDPOINT_URL = endpoint;
    process.env.SYNAPSE_S3_ACCESS_KEY_ID = "stub-access-key";
    process.env.SYNAPSE_S3_SECRET_ACCESS_KEY = "stub-secret-key";
    h = await startHarness();
    tenant = await makeTenant(h, "s3");
  });

  afterAll(async () => {
    await stopHarness(h);
    await stub.stop();
    // A later suite in the same worker must not inherit the bucket.
    delete process.env.SYNAPSE_S3_BUCKET;
    delete process.env.SYNAPSE_S3_ENDPOINT_URL;
    delete process.env.SYNAPSE_S3_ACCESS_KEY_ID;
    delete process.env.SYNAPSE_S3_SECRET_ACCESS_KEY;
  });

  it("reserves, presigns, accepts the client's PUT and completes to ready", async () => {
    const body = Buffer.from("a".repeat(1024));
    const presigned = await h.http
      .post("/v1/files/presign-upload")
      .set(tenant.headers)
      .send({ name: "big.bin", size_bytes: body.length, content_type: "application/octet-stream" });
    expect(presigned.status, presigned.text).toBe(200);
    expect(Object.keys(presigned.body).sort()).toEqual(["expires_in", "headers", "id", "key", "method", "url"]);
    expect(presigned.body.method).toBe("PUT");
    expect(presigned.body.headers["Content-Type"]).toBe("application/octet-stream");
    expect(presigned.body.key).toBe(`${tenant.orgId}/big.bin`);
    expect(presigned.body.url).toContain(`/${BUCKET}/${tenant.orgId}/big.bin`);

    // The reservation is already counted, and the row is not listable yet.
    expect(await storageUsed()).toBe(body.length);
    expect((await h.http.get("/v1/files").set(tenant.headers)).body).toEqual([]);

    const put = await fetch(presigned.body.url as string, { method: "PUT", body, headers: { "Content-Type": "application/octet-stream" } });
    expect(put.status).toBe(200);
    expect(stub.objects.get(`${tenant.orgId}/big.bin`)?.body.length).toBe(body.length);

    const completed = await h.http.post(`/v1/files/${presigned.body.id}/complete`).set(tenant.headers);
    expect(completed.status, completed.text).toBe(200);
    expect(completed.body).toMatchObject({ status: "ready", size_bytes: body.length });

    // `file.uploaded` fires on the pending -> ready transition, not on the
    // presign, and the idempotent re-complete must not fire it a second time.
    const audited = await h.http.get("/v1/audit").set(tenant.headers).query({ event_type: "file.uploaded" });
    expect(audited.body.data.map((r: { target_id: string }) => r.target_id)).toEqual([presigned.body.id]);
    expect(audited.body.data[0].diff).toEqual({ file_id: presigned.body.id, name: "big.bin", content_type: "application/octet-stream", size_bytes: body.length });

    const again = await h.http.post(`/v1/files/${presigned.body.id}/complete`).set(tenant.headers);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(presigned.body.id);
    expect((await h.http.get("/v1/audit").set(tenant.headers).query({ event_type: "file.uploaded" })).body.data).toHaveLength(1);

    const listed = await h.http.get("/v1/files").set(tenant.headers);
    expect(listed.body.map((f: { id: string }) => f.id)).toEqual([presigned.body.id]);

    const downloaded = await h.http.get(`/v1/files/${presigned.body.id}`).set(tenant.headers).responseType("blob");
    expect(Buffer.from(downloaded.body as Buffer).length).toBe(body.length);

    const presignGet = await h.http.post(`/v1/files/${presigned.body.id}/presign`).set(tenant.headers);
    expect(presignGet.status, presignGet.text).toBe(200);
    expect(presignGet.body.url).toContain("X-Amz-Signature=");
    expect(presignGet.body.key).toBe(`${tenant.orgId}/big.bin`);
    expect(presignGet.body.expires_in).toBe(3600);

    await h.http.delete(`/v1/files/${presigned.body.id}`).set(tenant.headers).expect(204);
    expect(stub.objects.has(`${tenant.orgId}/big.bin`)).toBe(false);
    expect(await storageUsed()).toBe(0);
    const emitted = await h.pool.query<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at", [
      presigned.body.id,
    ]);
    expect(emitted.rows.map((r) => r.event_type)).toEqual(["file.uploaded", "file.deleted"]);
  });

  it("releases the reservation when the bytes never arrive — and the 409 does not roll it back", async () => {
    const before = await storageUsed();
    const presigned = await h.http
      .post("/v1/files/presign-upload")
      .set(tenant.headers)
      .send({ name: "never.bin", size_bytes: 4096, content_type: "application/octet-stream" });
    expect(presigned.status, presigned.text).toBe(200);
    expect(await storageUsed()).toBe(before + 4096);

    const incomplete = await h.http.post(`/v1/files/${presigned.body.id}/complete`).set(tenant.headers);
    expect(incomplete.status, incomplete.text).toBe(409);
    expect(incomplete.body.type).toContain("upload_incomplete");
    expect(incomplete.body).toMatchObject({ expected_bytes: 4096, actual_bytes: null });

    // The release committed despite the error, and the pending row is gone.
    expect(await storageUsed()).toBe(before);
    expect((await h.http.post(`/v1/files/${presigned.body.id}/complete`).set(tenant.headers)).status).toBe(404);
    // Nothing became ready, so no `file.uploaded` for this id.
    const emitted = await h.pool.query("SELECT 1 FROM outbox_events WHERE aggregate_id = $1", [presigned.body.id]);
    expect(emitted.rowCount).toBe(0);
  });

  it("rejects a completed upload whose size does not match the reservation", async () => {
    const before = await storageUsed();
    const presigned = await h.http
      .post("/v1/files/presign-upload")
      .set(tenant.headers)
      .send({ name: "short.bin", size_bytes: 4096, content_type: "application/octet-stream" });
    await fetch(presigned.body.url as string, {
      method: "PUT",
      body: Buffer.alloc(10),
      headers: { "Content-Type": "application/octet-stream" },
    });

    const mismatch = await h.http.post(`/v1/files/${presigned.body.id}/complete`).set(tenant.headers);
    expect(mismatch.status, mismatch.text).toBe(409);
    expect(mismatch.body).toMatchObject({ expected_bytes: 4096, actual_bytes: 10 });
    expect(await storageUsed()).toBe(before);
  });

  it("gives back the bytes of presigned uploads that expired unfinished", async () => {
    const before = await storageUsed();
    const presigned = await h.http
      .post("/v1/files/presign-upload")
      .set(tenant.headers)
      .send({ name: "abandoned.bin", size_bytes: 8192, content_type: "application/octet-stream" });
    expect(await storageUsed()).toBe(before + 8192);

    // Age the row past `SYNAPSE_STORAGE_PRESIGN_SECONDS * 2`.
    await h.pool.query("UPDATE stored_files SET created_at = now() - interval '30 days' WHERE id = $1", [presigned.body.id]);
    const { JobsService } = await import("../../src/worker/jobs.service");
    await h.app.get(JobsService).purgeExpired();

    expect(await storageUsed()).toBe(before);
    const row = await h.pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM stored_files WHERE id = $1", [presigned.body.id]);
    expect(row.rows[0]?.deleted_at).not.toBeNull();
    // Retention is not a tenant action: the reference's `purge_expired` emits
    // no `file.deleted` for an upload that never became a file.
    const emitted = await h.pool.query("SELECT 1 FROM outbox_events WHERE aggregate_id = $1", [presigned.body.id]);
    expect(emitted.rowCount).toBe(0);
  });

  async function storageUsed(): Promise<number> {
    const summary = await h.http.get("/v1/usage/summary").set(tenant.headers);
    const row = summary.body.metrics.find((m: { metric: string }) => m.metric === "storage_bytes");
    return row ? Number(row.used) : 0;
  }
});
