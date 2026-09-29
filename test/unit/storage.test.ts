import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageError, TenantViolationError } from "../../src/core/errors";
import { LocalDiskStorage } from "../../src/storage/local-disk.backend";
import { S3Storage } from "../../src/storage/s3.backend";
import { scopedKey, validateKey } from "../../src/storage/keys";
import { StubS3Server } from "../support/stub-s3-server";

const ORG = "3f1d1a52-6f0c-4b2f-9f2d-0e3c0a9a7b11";
const OTHER_ORG = "8a6f0b41-2c7e-4d9a-bb31-6d2f0c5e1a02";

describe("storage keys", () => {
  it("builds an org-scoped key from a plain name", () => {
    expect(scopedKey(ORG, "a.txt")).toBe(`${ORG}/a.txt`);
  });

  it("keeps nested paths and strips a leading slash", () => {
    expect(scopedKey(ORG, "/reports/2026/q1.csv")).toBe(`${ORG}/reports/2026/q1.csv`);
  });

  it("refuses traversal segments", () => {
    expect(() => scopedKey(ORG, "reports/../../etc/passwd")).toThrow(StorageError);
  });

  it("refuses names the key pattern rejects", () => {
    expect(() => scopedKey(ORG, "space here.txt")).toThrow(StorageError);
    expect(() => scopedKey(ORG, "a".repeat(600))).toThrow(StorageError);
    expect(() => scopedKey(ORG, "\u0000.txt")).toThrow(StorageError);
  });

  it("accepts an empty name as the bare org prefix, like the reference", () => {
    // The route never sends one (`filename or "unnamed"`), but `_KEY_RE`
    // admits a trailing slash and the two servers must agree on the edge.
    expect(scopedKey(ORG, "")).toBe(`${ORG}/`);
  });

  it("refuses a key that belongs to another organization", () => {
    expect(() => {
      validateKey(`${OTHER_ORG}/a.txt`, ORG);
    }).toThrow(TenantViolationError);
  });

  it("accepts a bare key when no organization is asserted", () => {
    expect(() => {
      validateKey(`${OTHER_ORG}/a.txt`);
    }).not.toThrow();
  });
});

describe("local disk backend", () => {
  let root: string;
  let storage: LocalDiskStorage;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "synapse-storage-"));
    storage = new LocalDiskStorage(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes through nested keys and reports their size", async () => {
    const key = scopedKey(ORG, "reports/q1.txt");
    await storage.put(key, Buffer.from("hello"), "text/plain");
    expect((await storage.get(key)).toString("utf8")).toBe("hello");
    expect(await storage.head(key)).toBe(5);
  });

  it("head is null for an object that was never written, and after delete", async () => {
    const key = scopedKey(ORG, "gone.txt");
    expect(await storage.head(key)).toBeNull();
    await storage.put(key, Buffer.from("x"), "text/plain");
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
  });

  it("cannot presign in either direction", async () => {
    expect(storage.supportsPresignedUpload).toBe(false);
    await expect(storage.presignGet(scopedKey(ORG, "a.txt"))).rejects.toThrow(StorageError);
    await expect(storage.presignPut(scopedKey(ORG, "a.txt"), "text/plain")).rejects.toThrow(StorageError);
  });

  it("refuses a key that escapes the root", async () => {
    await expect(storage.get("../outside.txt")).rejects.toThrow(StorageError);
  });
});

describe("S3-compatible backend", () => {
  const stub = new StubS3Server("synapse-test");
  let storage: S3Storage;

  beforeAll(async () => {
    const endpoint = await stub.start();
    storage = new S3Storage({
      bucket: "synapse-test",
      region: "us-east-1",
      endpoint,
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      presignSeconds: 900,
    });
  });

  afterAll(async () => {
    await stub.stop();
  });

  it("puts, gets, heads and deletes through the path-style endpoint", async () => {
    const key = scopedKey(ORG, "s3/object.bin");
    await storage.put(key, Buffer.from("payload"), "application/octet-stream");
    expect(stub.objects.get(key)?.body.toString("utf8")).toBe("payload");
    expect((await storage.get(key)).toString("utf8")).toBe("payload");
    expect(await storage.head(key)).toBe(7);
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
  });

  it("reports a missing object as a 404, not a storage failure", async () => {
    await expect(storage.get(scopedKey(ORG, "s3/missing.bin"))).rejects.toMatchObject({ status: 404 });
  });

  it("presigns a SigV4 GET with the configured lifetime", async () => {
    const url = new URL(await storage.presignGet(scopedKey(ORG, "s3/object.bin")));
    expect(url.pathname).toBe(`/synapse-test/${ORG}/s3/object.bin`);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("test-access-key");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("presigns a PUT that commits the client to the declared content type", async () => {
    const url = new URL(await storage.presignPut(scopedKey(ORG, "s3/upload.bin"), "image/png"));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    // A CRC32 of an empty body would make the client's real PUT fail.
    expect(url.searchParams.get("x-amz-checksum-crc32")).toBeNull();
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("announces presigned upload support", () => {
    expect(storage.supportsPresignedUpload).toBe(true);
  });
});
