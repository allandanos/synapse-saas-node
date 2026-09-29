import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, PASSWORD, startHarness, stopHarness, TEST_DB, uid } from "./harness";

/**
 * Auth rate limiting end to end through the app (`test_auth_rate_limit.py`).
 *
 * Every case gets its own client address through `X-Forwarded-For` — the
 * harness's loopback peer is a trusted proxy here, so the buckets are isolated
 * from each other AND from a shared Redis window left by an earlier run, and
 * the trust rule itself gets exercised on the way.
 */
describe.skipIf(!TEST_DB)("auth rate limiting (real Postgres)", () => {
  let h: Harness;
  const before = {
    ip: process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP,
    id: process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY,
    proxies: process.env.SYNAPSE_TRUSTED_PROXIES,
  };
  let octet = 0;
  // A per-RUN prefix as well as a per-case octet: with a real Redis the
  // fixed-window counters outlive the process, so a rerun inside the same
  // minute would otherwise start on a half-spent bucket.
  const prefix = `10.${String(Math.floor(Math.random() * 256))}.${String(Math.floor(Math.random() * 256))}`;
  /** A fresh client address per case (private range, never routable). */
  const newIp = (): string => `${prefix}.${String((octet += 1))}`;

  beforeAll(async () => {
    process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP = "6";
    process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY = "3";
    process.env.SYNAPSE_AUTH_RATE_WINDOW_SECONDS = "60";
    process.env.SYNAPSE_TRUSTED_PROXIES = "127.0.0.0/8,::1/128";
    h = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(h);
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("SYNAPSE_AUTH_RATE_LIMIT_PER_IP", before.ip);
    restore("SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY", before.id);
    restore("SYNAPSE_TRUSTED_PROXIES", before.proxies);
  });

  it("trips the identity bucket and says how long to wait", async () => {
    // Register counts against the identity bucket too (creating the account is
    // an auth action on that identity), so 1 register + 2 logins reach 3.
    const ip = newIp();
    const email = `stuffed-${uid()}@example.com`;
    const register = await h.http.post("/v1/auth/register").set("X-Forwarded-For", ip).send({ email, password: PASSWORD, display_name: "S" });
    expect(register.status, register.text).toBe(201);
    for (let i = 0; i < 2; i += 1) {
      const res = await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email, password: "wrong-password-1" });
      expect(res.status, res.text).toBe(401); // normal rejection while under the cap
    }
    const blocked = await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email, password: "wrong-password-1" });
    expect(blocked.status, blocked.text).toBe(429);
    expect(blocked.body.type).toMatch(/\/rate_limited$/);
    expect(blocked.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(blocked.headers["retry-after"]).toBe(String(blocked.body.retry_after_seconds));
    expect(blocked.body.instance).toBe("/v1/auth/login");
  });

  it("blocking one account never blocks another from the same IP", async () => {
    const ip = newIp();
    const victim = `victim-${uid()}@example.com`;
    for (let i = 0; i < 3; i += 1) await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email: victim, password: "nope" });
    expect((await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email: victim, password: "nope" })).status).toBe(429);
    const other = await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email: `else-${uid()}@example.com`, password: "nope" });
    expect(other.status, other.text).toBe(401); // a different identity bucket
  });

  it("trips the IP bucket whatever the identity", async () => {
    const ip = newIp();
    for (let i = 0; i < 6; i += 1) {
      const res = await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email: `spray-${uid()}@example.com`, password: "nope" });
      expect(res.status, `attempt ${String(i)}: ${res.text}`).toBe(401);
    }
    const blocked = await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email: `spray-${uid()}@example.com`, password: "nope" });
    expect(blocked.status, blocked.text).toBe(429);
    // …and a different address is unaffected
    expect((await h.http.post("/v1/auth/login").set("X-Forwarded-For", newIp()).send({ email: `spray-${uid()}@example.com`, password: "nope" })).status).toBe(401);
  });

  it("is case-insensitive on the identity, so casing never buys extra attempts", async () => {
    const ip = newIp();
    const email = `Mixed-${uid()}@Example.com`;
    for (let i = 0; i < 3; i += 1) await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email: email.toUpperCase(), password: "nope" });
    expect((await h.http.post("/v1/auth/login").set("X-Forwarded-For", ip).send({ email: email.toLowerCase(), password: "nope" })).status).toBe(429);
  });

  it("leaves non-auth routes alone", async () => {
    const ip = newIp();
    for (let i = 0; i < 20; i += 1) expect((await h.http.get("/healthz").set("X-Forwarded-For", ip)).status).toBe(200);
  });

  it("the peeked body still reaches the handler", async () => {
    const email = `peek-${uid()}@example.com`;
    const res = await h.http.post("/v1/auth/register").set("X-Forwarded-For", newIp()).send({ email, password: PASSWORD, display_name: "P" });
    expect(res.status, res.text).toBe(201);
    expect(res.body.user.email).toBe(email);
  });

  it("a malformed body falls through to 422 instead of crashing the limiter", async () => {
    const res = await h.http.post("/v1/auth/login").set("X-Forwarded-For", newIp()).set("Content-Type", "application/json").send("not json at all");
    expect(res.status, res.text).toBe(422);
  });
});
