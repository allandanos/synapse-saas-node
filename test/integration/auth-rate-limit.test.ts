import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, PASSWORD, startHarness, stopHarness, TEST_DB, uid } from "./harness";

/**
 * Auth rate limiting end to end through the app (`test_auth_rate_limit.py`).
 * Tight limits so the suite needs few requests.
 */
describe.skipIf(!TEST_DB)("auth rate limiting (real Postgres)", () => {
  let h: Harness;
  const before = { ip: process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP, id: process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY };

  beforeAll(async () => {
    process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP = "50";
    process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY = "3";
    process.env.SYNAPSE_AUTH_RATE_WINDOW_SECONDS = "60";
    h = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(h);
    process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP = before.ip ?? "";
    process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY = before.id ?? "";
  });

  it("trips the identity bucket and says how long to wait", async () => {
    // Register counts against the identity bucket too (creating the account is
    // an auth action on that identity), so 1 register + 2 logins reach 3.
    const email = `stuffed-${uid()}@example.com`;
    expect((await h.http.post("/v1/auth/register").send({ email, password: PASSWORD, display_name: "S" })).status).toBe(201);
    for (let i = 0; i < 2; i += 1) {
      const res = await h.http.post("/v1/auth/login").send({ email, password: "wrong-password-1" });
      expect(res.status).toBe(401); // normal rejection while under the cap
    }
    const blocked = await h.http.post("/v1/auth/login").send({ email, password: "wrong-password-1" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.type).toMatch(/\/rate_limited$/);
    expect(blocked.body.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(blocked.headers["retry-after"]).toBe(String(blocked.body.retry_after_seconds));
    expect(blocked.body.instance).toBe("/v1/auth/login");
  });

  it("blocking one account never blocks another from the same IP", async () => {
    const victim = `victim-${uid()}@example.com`;
    await h.http.post("/v1/auth/register").send({ email: victim, password: PASSWORD, display_name: "V" });
    for (let i = 0; i < 3; i += 1) await h.http.post("/v1/auth/login").send({ email: victim, password: "wrong-password-x" });
    expect((await h.http.post("/v1/auth/login").send({ email: victim, password: "wrong-password-x" })).status).toBe(429);
    const other = await h.http.post("/v1/auth/login").send({ email: `else-${uid()}@example.com`, password: "wrong-password-x" });
    expect(other.status).toBe(401); // a different identity bucket
  });

  it("is case-insensitive on the identity, so casing never buys extra attempts", async () => {
    const email = `Mixed-${uid()}@Example.com`;
    for (let i = 0; i < 3; i += 1) await h.http.post("/v1/auth/login").send({ email: email.toUpperCase(), password: "nope" });
    expect((await h.http.post("/v1/auth/login").send({ email: email.toLowerCase(), password: "nope" })).status).toBe(429);
  });

  it("leaves non-auth routes alone", async () => {
    for (let i = 0; i < 10; i += 1) expect((await h.http.get("/healthz")).status).toBe(200);
  });

  it("the peeked body still reaches the handler", async () => {
    const email = `peek-${uid()}@example.com`;
    const res = await h.http.post("/v1/auth/register").send({ email, password: PASSWORD, display_name: "P" });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
  });

  it("a malformed body falls through to 422 instead of crashing the limiter", async () => {
    const res = await h.http.post("/v1/auth/login").set("Content-Type", "application/json").send("not json at all");
    expect(res.status).toBe(422);
  });
});
