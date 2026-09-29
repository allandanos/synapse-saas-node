import type { CacheBackend } from "../../src/core/cache/backend";

/**
 * An in-test stand-in for Redis (the reference's `TTLDictBackend`, minus the
 * clock): shared, versioned, and never expiring inside one test.
 */
export class MapCacheBackend implements CacheBackend {
  readonly configured = true;
  readonly store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }

  incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(next));
    return Promise.resolve(next);
  }

  incrWindow(key: string, windowSeconds: number): Promise<[number, number]> {
    const next = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(next));
    return Promise.resolve([next, windowSeconds]);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
