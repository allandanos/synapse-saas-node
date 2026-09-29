import { Logger } from "@nestjs/common";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Settings } from "../../core/config";
import { type DomainError, RateLimitedError } from "../../core/errors";
import type { RateLimiter } from "../../core/rate-limiter";
import { clientIp } from "./client-ip";

/**
 * Credential endpoints and the request field carrying the target identity
 * (`identity/rate_limit.py::AUTH_ROUTES`). `null` ⇒ the IP limit only.
 */
export const AUTH_ROUTES: Readonly<Record<string, string | null>> = {
  "/v1/auth/login": "email",
  "/v1/auth/register": "email",
  "/v1/auth/forgot-password": "email",
  "/v1/auth/reset-password": null, // token-based
  "/v1/auth/refresh": null, // a stolen refresh token replayed at speed
  "/v1/auth/oidc/start": null, // SSO round-trips
  "/v1/auth/oidc/callback": null,
};

const logger = new Logger("AuthRateLimit");

/**
 * Auth rate limiting.
 *
 * Two buckets protect every credential endpoint: the client IP (network
 * spray) and the target identity (stuffing one account). Either tripping
 * answers 429 with `Retry-After`.
 *
 * It runs in two phases because Express cannot re-read a consumed body:
 * `ipPhase` is mounted BEFORE the body parsers (so even a malformed body
 * costs an attempt, as it does in the reference), `identityPhase` after them
 * (the reference peeks the JSON without consuming it; reading the already
 * parsed body is the same observation). A body the parser rejects yields the
 * usual 422 and no identity attempt — the reference's `_peek_identity`
 * returns None on that body too.
 */
export class AuthRateLimitMiddleware {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly settings: Settings,
  ) {}

  /** Mount before the body parsers. */
  ipPhase(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!(req.path in AUTH_ROUTES)) return next();
      const ip = clientIp(req, this.settings.SYNAPSE_TRUSTED_PROXIES);
      void this.guard(req, res, next, `auth:ip:${ip}`, this.settings.SYNAPSE_AUTH_RATE_LIMIT_PER_IP);
    };
  }

  /** Mount after the body parsers. */
  identityPhase(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      const field = AUTH_ROUTES[req.path];
      if (!field || req.method !== "POST") return next();
      const identity = peekIdentity(req.body, field);
      if (!identity) return next();
      void this.guard(req, res, next, `auth:id:${identity}`, this.settings.SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY);
    };
  }

  private async guard(req: Request, res: Response, next: NextFunction, key: string, limit: number): Promise<void> {
    try {
      await this.limiter.check(key, limit, this.settings.SYNAPSE_AUTH_RATE_WINDOW_SECONDS);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        this.tooMany(req, res, error);
        return;
      }
      // Losing the store costs the distributed counter, never availability:
      // a Redis blip must not 429 every login.
      logger.warn(`auth rate limiter degraded: ${error instanceof Error ? error.message : String(error)}`);
    }
    next();
  }

  private tooMany(req: Request, res: Response, error: DomainError): void {
    const instance = (req.originalUrl || req.url).split("?")[0] as string;
    const retryAfter = Number(error.extras.retry_after_seconds ?? 60);
    logger.warn(`auth rate limited path=${instance} ip=${clientIp(req, this.settings.SYNAPSE_TRUSTED_PROXIES)}`);
    const requestId = res.getHeader("X-Request-Id");
    const problem = error.toProblem({ instance, requestId: typeof requestId === "string" ? requestId : undefined });
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json(problem);
  }
}

/** The lowercased identity, or null when the body carries none. */
function peekIdentity(body: unknown, field: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return value === undefined || value === null || value === "" ? null : String(value).toLowerCase();
}
