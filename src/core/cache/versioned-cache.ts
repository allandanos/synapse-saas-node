import type { CacheBackend } from "./backend";

export const DEFAULT_TTL_SECONDS = 60;
/** The counter must outlive every body it invalidates, or a stale body resurfaces. */
export const VERSION_TTL_SECONDS = 3600;

/**
 * A cache whose invalidation is a counter bump, not a delete.
 *
 * Every body lives under `{ns}:v{version}:{key}`, the version under
 * `{ns}:ver:{key}`. A reader fetches the (tiny) counter first and only then
 * the body; a writer bumps the counter, which orphans every body written
 * under the old one. Three rules keep it correct — each one closed a real bug
 * in the reference (`core/cache.py`):
 *
 * 1. `set` writes under the version observed at READ time (`getVersioned`),
 *    never one re-read at write time. A bump in between must leave the new
 *    version empty rather than fill it with the body that is now stale.
 * 2. `delete` is a bump. Resetting the counter to 0 would resurrect whatever
 *    was cached under version 0.
 * 3. Invalidation belongs AFTER commit — see `deferBump` on `Tx`. Bumping
 *    inside the transaction lets a concurrent reader recompute from the
 *    pre-commit rows and cache them under the NEW version, stale for a
 *    whole TTL.
 */
export class VersionedCache {
  constructor(
    readonly namespace: string,
    private readonly backend: CacheBackend,
    readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  private versionKey(key: string): string {
    return `${this.namespace}:ver:${key}`;
  }

  private bodyKey(key: string, version: number): string {
    return `${this.namespace}:v${String(version)}:${key}`;
  }

  private scopedKey(key: string, token: string): string {
    return `${this.namespace}:s[${token}]:${key}`;
  }

  async currentVersion(key: string): Promise<number> {
    const raw = await this.backend.get(this.versionKey(key));
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** `[body, version]` — hand the version back to `set` after a miss. */
  async getVersioned(key: string): Promise<[string | null, number]> {
    const version = await this.currentVersion(key);
    return [await this.backend.get(this.bodyKey(key, version)), version];
  }

  async get(key: string): Promise<string | null> {
    return (await this.getVersioned(key))[0];
  }

  /** Store under `version` (from `getVersioned`); a fresh read when omitted. */
  async set(key: string, value: string, version?: number): Promise<void> {
    const at = version ?? (await this.currentVersion(key));
    await this.backend.set(this.bodyKey(key, at), value, this.ttlSeconds);
  }

  /**
   * A body that several counters can invalidate (a flag evaluation depends on
   * the global, org and user scopes). Returns `[body, token]`; hand the token
   * back to `setScoped` after a miss.
   */
  async getScoped(key: string, ...scopes: string[]): Promise<[string | null, string]> {
    const parts: string[] = [];
    for (const scope of scopes) parts.push(`${scope}=${String(await this.currentVersion(scope))}`);
    const token = parts.join(",");
    return [await this.backend.get(this.scopedKey(key, token)), token];
  }

  async setScoped(key: string, value: string, token: string): Promise<void> {
    await this.backend.set(this.scopedKey(key, token), value, this.ttlSeconds);
  }

  /** Invalidate: increment the version counter. The next read misses. */
  bump(key: string): Promise<number> {
    return this.backend.incr(this.versionKey(key), VERSION_TTL_SECONDS);
  }

  /** Invalidate — a bump, never a reset (rule 2 above). */
  async delete(key: string): Promise<void> {
    await this.bump(key);
  }

  /**
   * The mutation-side invalidation: bump NOW so the rest of this request
   * recomputes, and again after the commit so no concurrent reader caches the
   * pre-commit rows under the new version for a whole TTL.
   */
  async invalidate(tx: BumpDeferrer, key: string): Promise<void> {
    await this.bump(key);
    tx.deferBump(this, key);
  }
}

/** What `invalidate` needs of a transaction — `Tx` satisfies it. */
export interface BumpDeferrer {
  deferBump(cache: VersionedCache, key: string): void;
}
