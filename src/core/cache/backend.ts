/**
 * Cache transport. Two implementations: Redis (shared, the real thing) and a
 * pass-through that misses every read.
 *
 * Errors are the backend's problem, never the caller's: a Redis blip is
 * logged and reported as a miss / a no-op write, so a cache outage costs
 * latency and nothing else (`VersionedCache` recomputes).
 */
export interface CacheBackend {
  /** True when a real store is behind this backend (`/readyz` reports it). */
  readonly configured: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** INCR + a TTL on the counter. Returns the new value, or -1 when the store failed. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Fixed-window counter: [count, seconds left in the window]. Throws on a store failure. */
  incrWindow(key: string, windowSeconds: number): Promise<[count: number, ttl: number]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * No `SYNAPSE_REDIS_URL`: every read misses and every write is dropped, so
 * callers recompute on each request — correct, just not fast. (The reference
 * keeps an in-process TTL dict here; a per-worker dict is a dev convenience
 * that lies as soon as a second process exists, so the port does without.)
 */
export class PassThroughBackend implements CacheBackend {
  readonly configured = false;
  private readonly counters = new Map<string, { count: number; window: number }>();

  get(): Promise<string | null> {
    return Promise.resolve(null);
  }

  set(): Promise<void> {
    return Promise.resolve();
  }

  incr(): Promise<number> {
    return Promise.resolve(0);
  }

  /** The rate limiter still needs to count: an in-process window, per worker. */
  incrWindow(key: string, windowSeconds: number): Promise<[number, number]> {
    const now = Math.floor(Date.now() / 1000);
    const window = Math.floor(now / windowSeconds);
    const entry = this.counters.get(key);
    const count = entry && entry.window === window ? entry.count + 1 : 1;
    this.counters.set(key, { count, window });
    return Promise.resolve([count, windowSeconds - (now % windowSeconds)]);
  }

  ping(): Promise<void> {
    return Promise.reject(new Error("redis is not configured"));
  }

  close(): Promise<void> {
    this.counters.clear();
    return Promise.resolve();
  }
}
