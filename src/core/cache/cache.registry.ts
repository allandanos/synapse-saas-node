import { Inject, Injectable } from "@nestjs/common";
import type { Settings } from "../config";
import type { CacheBackend } from "./backend";
import { InProcessTtlBackend, PassThroughBackend } from "./backend";
import { RedisBackend } from "./redis.backend";
import { VersionedCache } from "./versioned-cache";

export const CACHE_BACKEND = Symbol("CACHE_BACKEND");

/**
 * The namespaces and TTLs the reference uses, in one place (`core/cache.py`
 * consumers): a namespace is a bump domain, so two features sharing one would
 * invalidate each other.
 */
export interface CacheNamespace {
  readonly name: string;
  readonly ttl: number;
  /**
   * True when the entries are state, not a memo: losing them breaks a flow
   * rather than costing a recomputation. Such a namespace falls back to a
   * per-process TTL map when no Redis is configured instead of missing.
   */
  readonly durable?: boolean;
}

export const CACHE_NAMESPACES = {
  /** Effective permission set per (user, org) — `authorization/service.py`. */
  PERM: { name: "perm", ttl: 30 },
  /** OpenFGA decisions, scoped on `{user}:{object}` — bumped with PERM. */
  FGA: { name: "fga", ttl: 30 },
  /** Effective entitlements per org — `entitlements/service.py`. */
  ENTITLEMENTS: { name: "entl", ttl: 60 },
  /** Flag evaluations, scoped on (all, org, user) — `feature_flags/service.py`. */
  FLAGS: { name: "fflags", ttl: 30 },
  /** Membership lookups — declared by the reference (`tenancy/dependencies.py`), unused there. */
  MEMBER: { name: "member", ttl: 60 },
  /** OIDC login state (PKCE verifier + nonce), single use — `identity/router.py`. */
  OIDC: { name: "oidc", ttl: 600, durable: true },
} as const satisfies Record<string, CacheNamespace>;

export function createCacheBackend(settings: Settings): CacheBackend {
  return settings.SYNAPSE_REDIS_URL ? new RedisBackend(settings.SYNAPSE_REDIS_URL) : new PassThroughBackend();
}

/**
 * Hands out the process-wide `VersionedCache` per namespace. One instance per
 * namespace so two services bumping the same namespace agree on the keys
 * (the reference's module-level singletons, reachable through DI instead).
 */
@Injectable()
export class CacheRegistry {
  private readonly caches = new Map<string, VersionedCache>();
  /** Shared by every `durable` namespace when Redis is absent. */
  private fallback?: InProcessTtlBackend;

  constructor(@Inject(CACHE_BACKEND) private readonly backend: CacheBackend) {}

  namespace(spec: CacheNamespace): VersionedCache {
    const existing = this.caches.get(spec.name);
    if (existing) return existing;
    const cache = new VersionedCache(spec.name, this.backendFor(spec), spec.ttl);
    this.caches.set(spec.name, cache);
    return cache;
  }

  private backendFor(spec: CacheNamespace): CacheBackend {
    if (this.backend.configured || !spec.durable) return this.backend;
    this.fallback ??= new InProcessTtlBackend();
    return this.fallback;
  }

  get configured(): boolean {
    return this.backend.configured;
  }

  /** `/readyz`: `ok` | `error: …` | `not_configured` (`api/app.py`). */
  async health(): Promise<string> {
    if (!this.backend.configured) return "not_configured";
    try {
      await this.backend.ping();
      return "ok";
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
