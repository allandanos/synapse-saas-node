import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import type { CacheBackend } from "./backend";

/** Keep a slow/missing Redis from becoming request latency. */
const CONNECT_TIMEOUT_MS = 2000;
const COMMAND_TIMEOUT_MS = 2000;

/**
 * The shared Redis store (`SYNAPSE_REDIS_URL`).
 *
 * Read/write failures are logged once per call and answered as a miss — the
 * caller recomputes. `incrWindow` is the exception: the rate limiter must be
 * able to tell "not limited" from "the limiter is broken", so it throws and
 * the middleware fails open deliberately (§2).
 */
export class RedisBackend implements CacheBackend {
  readonly configured = true;
  private readonly logger = new Logger(RedisBackend.name);
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, {
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      // One retry, then pending commands are flushed with an error rather
      // than hanging: a cache read must degrade to a miss quickly. The offline
      // queue stays ON so the very first commands (issued while the socket is
      // still connecting at boot) are not thrown away.
      maxRetriesPerRequest: 1,
    });
    // ioredis emits `error` asynchronously; an unhandled one would kill the process.
    this.redis.on("error", (error: Error) => {
      this.logger.warn(`redis error: ${error.message}`);
    });
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (error) {
      this.degraded("get", error);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, "EX", ttlSeconds);
    } catch (error) {
      this.degraded("set", error);
    }
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    try {
      const value = await this.redis.incr(key);
      await this.redis.expire(key, ttlSeconds);
      return value;
    } catch (error) {
      this.degraded("incr", error);
      return -1;
    }
  }

  async incrWindow(key: string, windowSeconds: number): Promise<[number, number]> {
    const [countResult, ttlResult] = (await this.redis.pipeline().incr(key).ttl(key).exec()) ?? [];
    const failure = countResult?.[0] ?? ttlResult?.[0];
    if (failure) throw failure;
    const count = Number(countResult?.[1] ?? 0);
    let ttl = Number(ttlResult?.[1] ?? -1);
    if (ttl === -1) {
      // INCR created the key without an expiry (first hit raced) — set it.
      await this.redis.expire(key, windowSeconds);
      ttl = windowSeconds;
    }
    return [count, ttl];
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    this.redis.disconnect();
    return Promise.resolve();
  }

  private degraded(op: string, error: unknown): void {
    this.logger.warn(`redis ${op} failed (treated as a miss): ${error instanceof Error ? error.message : String(error)}`);
  }
}
