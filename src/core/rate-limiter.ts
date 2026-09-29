import { Inject, Injectable } from "@nestjs/common";
import { CACHE_BACKEND } from "./cache/cache.registry";
import type { CacheBackend } from "./cache/backend";
import { RateLimitedError } from "./errors";

/**
 * Fixed-window counter (`core/rate_limit.py`). Redis INCR+EXPIRE when
 * configured, an in-process window otherwise — acceptable degradation for a
 * single instance; production runs Redis.
 *
 * Two keys protect every auth attempt: the client IP (network-level spray)
 * and the target identity (credential stuffing against one account). Either
 * tripping blocks the request with 429.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(CACHE_BACKEND) private readonly backend: CacheBackend) {}

  /**
   * Throws `RateLimitedError` when `key` exceeds `limit` in the window.
   * A store failure propagates — the caller decides to fail open.
   */
  async check(key: string, limit: number, windowSeconds: number): Promise<void> {
    const [count, ttl] = await this.backend.incrWindow(`rl:${key}`, windowSeconds);
    if (count > limit) {
      throw new RateLimitedError("Too many attempts; slow down and retry shortly", {
        retry_after_seconds: Math.max(ttl, 1),
        limit,
      });
    }
  }
}
