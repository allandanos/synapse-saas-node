import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { PassThroughBackend } from "../../src/core/cache/backend";
import { loadSettings } from "../../src/core/config";
import { type DomainError, RateLimitedError } from "../../src/core/errors";
import { RateLimiter } from "../../src/core/rate-limiter";
import { AUTH_ROUTES } from "../../src/identity/rate-limit/auth-rate-limit.middleware";
import { clientIp } from "../../src/identity/rate-limit/client-ip";

// ── Client identification ────────────────────────────────────────────────────

const request = (
  peer: string,
  xff?: string,
): Pick<Request, "socket" | "headers"> =>
  ({
    socket: { remoteAddress: peer } as Request["socket"],
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  }) as Pick<Request, "socket" | "headers">;

describe("client IP — no trusted proxies", () => {
  it("ignores X-Forwarded-For outright", () => {
    // An attacker rotating the header must still be bucketed by the socket peer
    expect(clientIp(request("203.0.113.9", "1.1.1.1"), [])).toBe("203.0.113.9");
  });

  it("calls a missing peer 'unknown'", () => {
    const req = {
      socket: {} as Request["socket"],
      headers: { "x-forwarded-for": "1.1.1.1" },
    } as Pick<Request, "socket" | "headers">;
    expect(clientIp(req, [])).toBe("unknown");
  });
});

describe("client IP — behind trusted proxies", () => {
  const TRUSTED = ["10.0.0.0/8", "192.168.0.0/16"];

  it("takes the rightmost untrusted hop", () => {
    // client → proxyA(10.0.0.5) → proxyB(10.0.0.6) → us; each proxy appends its peer
    expect(
      clientIp(request("10.0.0.6", "198.51.100.7, 10.0.0.5"), TRUSTED),
    ).toBe("198.51.100.7");
  });

  it("skips a client-spoofed prefix", () => {
    // The attacker sent "X-Forwarded-For: 1.1.1.1"; the proxy appended the real peer
    expect(
      clientIp(request("10.0.0.6", "1.1.1.1, 198.51.100.7"), ["10.0.0.0/8"]),
    ).toBe("198.51.100.7");
  });

  it("ignores the header from an untrusted peer", () => {
    expect(clientIp(request("203.0.113.9", "1.1.1.1"), ["10.0.0.0/8"])).toBe(
      "203.0.113.9",
    );
  });

  it("falls back to the peer when every hop is trusted", () => {
    expect(clientIp(request("10.0.0.6", "10.0.0.5"), ["10.0.0.0/8"])).toBe(
      "10.0.0.6",
    );
  });

  it("does not trust a garbage hop", () => {
    expect(
      clientIp(request("10.0.0.6", "not-an-ip, 10.0.0.5"), ["10.0.0.0/8"]),
    ).toBe("not-an-ip");
  });

  it("matches IPv6 peers and networks", () => {
    expect(clientIp(request("::1", "2001:db8::7, ::1"), ["::1/128"])).toBe(
      "2001:db8::7",
    );
    expect(clientIp(request("2001:db8::9", "1.1.1.1"), ["::1/128"])).toBe(
      "2001:db8::9",
    );
  });
});

describe("trusted-proxy settings", () => {
  it("parses CSV and JSON lists", () => {
    expect(
      loadSettings({ SYNAPSE_TRUSTED_PROXIES: "10.0.0.0/8, 172.16.0.0/12" })
        .SYNAPSE_TRUSTED_PROXIES,
    ).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    expect(
      loadSettings({ SYNAPSE_TRUSTED_PROXIES: '["10.0.0.0/8"]' })
        .SYNAPSE_TRUSTED_PROXIES,
    ).toEqual(["10.0.0.0/8"]);
  });

  it("refuses a garbage CIDR", () => {
    expect(() =>
      loadSettings({ SYNAPSE_TRUSTED_PROXIES: "not-a-cidr" }),
    ).toThrow();
  });
});

describe("production guardrails", () => {
  const PROD = {
    SYNAPSE_ENV: "production",
    SYNAPSE_SECRET_KEY: "a-real-production-secret-key-32-bytes",
  };

  it("refuses limits above the production ceilings", () => {
    expect(() =>
      loadSettings({ ...PROD, SYNAPSE_AUTH_RATE_LIMIT_PER_IP: "1000" }),
    ).toThrow(/ceiling of 100/);
    expect(() =>
      loadSettings({ ...PROD, SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY: "100" }),
    ).toThrow(/ceiling of 20/);
  });

  it("accepts limits at the ceiling", () => {
    const settings = loadSettings({
      ...PROD,
      SYNAPSE_AUTH_RATE_LIMIT_PER_IP: "100",
      SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY: "20",
    });
    expect(settings.SYNAPSE_AUTH_RATE_LIMIT_PER_IP).toBe(100);
  });

  it("still refuses the dev secret, and says everything that is wrong at once", () => {
    expect(() =>
      loadSettings({
        SYNAPSE_ENV: "production",
        SYNAPSE_AUTH_RATE_LIMIT_PER_IP: "1000",
      }),
    ).toThrow(/ceiling of 100.*dev default/s);
  });
});

// ── The counter ──────────────────────────────────────────────────────────────

describe("RateLimiter — fixed window", () => {
  const limiter = (): RateLimiter => new RateLimiter(new PassThroughBackend());

  it("allows exactly `limit` attempts, then 429s with Retry-After", async () => {
    const rl = limiter();
    for (let i = 0; i < 3; i += 1)
      await expect(rl.check("auth:id:a@b.c", 3, 60)).resolves.toBeUndefined();
    await expect(rl.check("auth:id:a@b.c", 3, 60)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    const error = await rl.check("auth:id:a@b.c", 3, 60).then(
      () => null,
      (e: unknown) => e as DomainError,
    );
    expect(error).not.toBeNull();
    expect(error?.status).toBe(429);
    expect(error?.title).toBe("rate_limited");
    expect(Number(error?.extras.retry_after_seconds)).toBeGreaterThanOrEqual(1);
    expect(error?.extras.limit).toBe(3);
  });

  it("buckets keys independently", async () => {
    const rl = limiter();
    await rl.check("auth:id:victim@example.com", 1, 60);
    await expect(
      rl.check("auth:id:victim@example.com", 1, 60),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      rl.check("auth:id:someone-else@example.com", 1, 60),
    ).resolves.toBeUndefined();
  });

  it("the problem document carries retry_after_seconds", async () => {
    const rl = limiter();
    await rl.check("k", 0, 60).then(
      () => expect.fail("a limit of 0 must reject"),
      (error: unknown) => {
        const problem = (error as DomainError).toProblem({
          instance: "/v1/auth/login",
        });
        expect(problem.type).toMatch(/\/rate_limited$/);
        expect(problem.title).toBe("rate limited");
        expect(problem.status).toBe(429);
        expect(problem.instance).toBe("/v1/auth/login");
        expect(Number(problem.retry_after_seconds)).toBeGreaterThanOrEqual(1);
      },
    );
  });
});

describe("AUTH_ROUTES", () => {
  it("covers the reference's credential endpoints and their identity fields", () => {
    expect(AUTH_ROUTES).toEqual({
      "/v1/auth/login": "email",
      "/v1/auth/register": "email",
      "/v1/auth/forgot-password": "email",
      "/v1/auth/reset-password": null,
      "/v1/auth/refresh": null,
      "/v1/auth/oidc/start": null,
      "/v1/auth/oidc/callback": null,
    });
  });
});
