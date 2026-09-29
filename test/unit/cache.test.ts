import { describe, expect, it } from "vitest";
import { RedisBackend } from "../../src/core/cache/redis.backend";
import { MapCacheBackend } from "../support/map-cache-backend";
import type { CacheBackend } from "../../src/core/cache/backend";
import { PassThroughBackend } from "../../src/core/cache/backend";
import { VersionedCache } from "../../src/core/cache/versioned-cache";

/** Stands in for `Tx` — only `deferBump` matters here. */
class FakeTx {
  readonly pending: { cache: VersionedCache; key: string }[] = [];

  deferBump(cache: VersionedCache, key: string): void {
    if (this.pending.some((entry) => entry.cache === cache && entry.key === key)) return;
    this.pending.push({ cache, key });
  }

  async commit(): Promise<number> {
    const drained = this.pending.splice(0, this.pending.length);
    for (const { cache, key } of drained) await cache.bump(key);
    return drained.length;
  }
}

const cacheOn = (backend: CacheBackend, ns = "t"): VersionedCache => new VersionedCache(ns, backend, 60);

describe("VersionedCache — version at read", () => {
  it("set uses the version seen at read, so a bump between leaves the new version empty", async () => {
    const cache = cacheOn(new MapCacheBackend());
    const [body, version] = await cache.getVersioned("k");
    expect(body).toBeNull();
    expect(version).toBe(0);

    await cache.bump("k"); // a concurrent writer invalidated meanwhile
    await cache.set("k", "stale-body", version);

    expect(await cache.get("k")).toBeNull(); // the stale body sits under v0 only
    expect(await cache.currentVersion("k")).toBe(1);
  });

  it("set without a version reads a fresh one", async () => {
    const cache = cacheOn(new MapCacheBackend());
    await cache.bump("k");
    await cache.set("k", "v1-body");
    expect(await cache.get("k")).toBe("v1-body");
  });

  it("delete is a bump, not a reset", async () => {
    const cache = cacheOn(new MapCacheBackend());
    await cache.set("k", "under-v0");
    await cache.bump("k");
    await cache.set("k", "under-v1");
    await cache.delete("k");
    // Resetting to 0 would resurrect "under-v0"; a bump moves to v2 (empty).
    expect(await cache.get("k")).toBeNull();
    expect(await cache.currentVersion("k")).toBe(2);
  });

  it("scoped bodies miss when any scope bumps", async () => {
    const cache = cacheOn(new MapCacheBackend(), "flags");
    const [body, token] = await cache.getScoped("flag", "all", "org:o1", "user:u1");
    expect(body).toBeNull();
    await cache.setScoped("flag", "1", token);
    expect((await cache.getScoped("flag", "all", "org:o1", "user:u1"))[0]).toBe("1");
    // A different scope set never sees this body, even at identical versions.
    expect((await cache.getScoped("flag", "all", "org:o1", "user:u2"))[0]).toBeNull();
    await cache.bump("user:u1");
    expect((await cache.getScoped("flag", "all", "org:o1", "user:u1"))[0]).toBeNull();
    await cache.bump("all");
    expect((await cache.getScoped("flag", "all", "org:o1", "user:u1"))[0]).toBeNull();
  });

  it("keys are namespaced, so two caches never collide", async () => {
    const backend = new MapCacheBackend();
    const a = cacheOn(backend, "perm");
    const b = cacheOn(backend, "entl");
    await a.set("k", "from-perm");
    expect(await b.get("k")).toBeNull();
    await b.bump("k");
    expect(await a.get("k")).toBe("from-perm");
  });
});

describe("VersionedCache — deferred invalidation", () => {
  it("a deferred bump runs after the commit, de-duplicated", async () => {
    const cache = cacheOn(new MapCacheBackend());
    const tx = new FakeTx();
    tx.deferBump(cache, "k");
    tx.deferBump(cache, "k");
    expect(await cache.currentVersion("k")).toBe(0); // nothing yet: the change is not durable
    expect(await tx.commit()).toBe(1);
    expect(await cache.currentVersion("k")).toBe(1);
    expect(await tx.commit()).toBe(0); // queue drained
  });

  it("invalidate bumps now AND queues a post-commit bump", async () => {
    const cache = cacheOn(new MapCacheBackend());
    const tx = new FakeTx();
    await cache.set("k", "before");
    await cache.invalidate(tx, "k");
    expect(await cache.get("k")).toBeNull(); // this request already recomputes
    expect(await cache.currentVersion("k")).toBe(1);
    await tx.commit();
    expect(await cache.currentVersion("k")).toBe(2); // and again once durable
  });

  it("a rollback discards the queued bumps", async () => {
    const cache = cacheOn(new MapCacheBackend());
    const tx = new FakeTx();
    tx.deferBump(cache, "k");
    tx.pending.length = 0; // discardDeferredBumps()
    expect(await tx.commit()).toBe(0);
    expect(await cache.currentVersion("k")).toBe(0);
  });
});

describe("VersionedCache — pass-through backend", () => {
  it("misses every read so callers recompute", async () => {
    const cache = cacheOn(new PassThroughBackend());
    await cache.set("k", "body");
    expect(await cache.get("k")).toBeNull();
    const [scoped, token] = await cache.getScoped("k", "all");
    expect(scoped).toBeNull();
    await cache.setScoped("k", "1", token);
    expect((await cache.getScoped("k", "all"))[0]).toBeNull();
    await cache.bump("k"); // never throws
  });
});

describe("VersionedCache — a broken store is a miss, never a 500", () => {
  const broken: CacheBackend = {
    configured: true,
    get: () => Promise.reject(new Error("ECONNREFUSED")),
    set: () => Promise.reject(new Error("ECONNREFUSED")),
    incr: () => Promise.reject(new Error("ECONNREFUSED")),
    incrWindow: () => Promise.reject(new Error("ECONNREFUSED")),
    ping: () => Promise.reject(new Error("ECONNREFUSED")),
    close: () => Promise.resolve(),
  };

  it("surfaces the backend's own failure handling", async () => {
    // RedisBackend swallows; this raw double does not — the contract is that
    // the backend decides, and VersionedCache adds no second opinion.
    const cache = cacheOn(broken);
    await expect(cache.get("k")).rejects.toThrow("ECONNREFUSED");
  });
});

/** The real transport, when a Redis is reachable (`pnpm test:db` sets the URL). */
const REDIS_URL = process.env.SYNAPSE_TEST_REDIS_URL ?? process.env.SYNAPSE_REDIS_URL ?? "";

describe.skipIf(!REDIS_URL)("VersionedCache — over a real Redis", () => {
  it("round-trips a body, and a bump orphans it", async () => {
    const backend = new RedisBackend(REDIS_URL);
    try {
      const cache = new VersionedCache(`itest-${String(process.pid)}-${String(Date.now())}`, backend, 60);
      const [miss, version] = await cache.getVersioned("k");
      expect(miss).toBeNull();
      await cache.set("k", "body", version);
      expect(await cache.get("k")).toBe("body");
      await cache.bump("k");
      expect(await cache.get("k")).toBeNull();
      expect(await cache.currentVersion("k")).toBe(version + 1);
    } finally {
      await backend.close();
    }
  });

  it("counts a fixed window and reports the seconds left", async () => {
    const backend = new RedisBackend(REDIS_URL);
    try {
      const key = `itest-window-${String(process.pid)}-${String(Date.now())}`;
      const [first, ttl] = await backend.incrWindow(key, 60);
      expect(first).toBe(1);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      expect((await backend.incrWindow(key, 60))[0]).toBe(2);
    } finally {
      await backend.close();
    }
  });

  it("ping answers, so /readyz can report ok", async () => {
    const backend = new RedisBackend(REDIS_URL);
    try {
      await expect(backend.ping()).resolves.toBeUndefined();
    } finally {
      await backend.close();
    }
  });
});
