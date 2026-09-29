import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearJwksCache } from "../../src/identity/oidc/jwks";
import { idToken, makeKeypair, StubIdp } from "../support/stub-idp";
import { type Harness, PASSWORD, startHarness, stopHarness, TEST_DB, uid } from "./harness";

/**
 * SSO login end to end through the API: start → (Keycloak, stubbed) → callback.
 *
 * Only the IdP's token and JWKS endpoints are stubbed; state handling, PKCE,
 * id_token verification, user linking, the refresh cookie and the console
 * redirect are the real code path (`tests/integration/test_oidc_login.py`).
 */
const idp = new StubIdp();
const keypair = makeKeypair();
const WEB_ORIGIN = "http://console.test";

describe.skipIf(!TEST_DB)("SSO login (real Postgres, stubbed IdP)", () => {
  let h: Harness;
  const before = { provider: process.env.SYNAPSE_IDENTITY_PROVIDER, origin: process.env.SYNAPSE_WEB_ORIGIN, perIp: process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP };

  beforeAll(async () => {
    await idp.start();
    idp.keys = [keypair.jwk];
    process.env.SYNAPSE_IDENTITY_PROVIDER = "keycloak";
    process.env.SYNAPSE_KEYCLOAK_BASE_URL = idp.origin;
    process.env.SYNAPSE_KEYCLOAK_REALM = "synapse";
    process.env.SYNAPSE_KEYCLOAK_CLIENT_ID = "synapse-web";
    process.env.SYNAPSE_KEYCLOAK_CLIENT_SECRET = "secret";
    process.env.SYNAPSE_WEB_ORIGIN = WEB_ORIGIN;
    // Every case starts a login from the same address; the IP bucket is not under test here.
    process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP = "500";
    h = await startHarness();
  });

  afterAll(async () => {
    await stopHarness(h);
    await idp.stop();
    clearJwksCache();
    process.env.SYNAPSE_IDENTITY_PROVIDER = before.provider ?? "local";
    process.env.SYNAPSE_WEB_ORIGIN = before.origin ?? "http://localhost:3000";
    process.env.SYNAPSE_KEYCLOAK_BASE_URL = "";
    process.env.SYNAPSE_AUTH_RATE_LIMIT_PER_IP = before.perIp ?? "";
  });

  /** Kick off the flow; returns the state and nonce as the IdP would receive them. */
  async function start(returnTo = "/dashboard/billing"): Promise<{ state: string; nonce: string }> {
    const res = await h.http.get("/v1/auth/oidc/start").query({ return_to: returnTo });
    expect(res.status, res.text).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(`${idp.origin}/realms/synapse/protocol/openid-connect/auth`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("redirect_uri")).toMatch(/\/v1\/auth\/oidc\/callback$/);
    return { state: location.searchParams.get("state") as string, nonce: location.searchParams.get("nonce") as string };
  }

  const userRow = async (email: string): Promise<{ id: string; identity_provider: string; provider_subject: string | null; password_hash: string | null } | undefined> =>
    (
      await h.pool.query<{ id: string; identity_provider: string; provider_subject: string | null; password_hash: string | null }>(
        "SELECT id::text, identity_provider, provider_subject, password_hash FROM users WHERE email = $1",
        [email],
      )
    ).rows[0];

  it("advertises the provider on /v1/meta", async () => {
    expect((await h.http.get("/v1/meta")).body.identity_provider).toBe("keycloak");
  });

  it("starts with long state and nonce, and neutralises an open redirect", async () => {
    const { state, nonce } = await start();
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    expect((await start("https://evil.test/phish")).state).toBeTruthy(); // proven at callback time below
  });

  it("creates an SSO-only user, sets the cookie, and bounces to the console", async () => {
    const email = `sso-${uid()}@example.com`;
    const { state, nonce } = await start();
    idp.nextToken = idToken(keypair, idp.issuer, { nonce, email, sub: `kc-${email}` });

    const res = await h.http.get("/v1/auth/oidc/callback").query({ code: "c-1", state });
    expect(res.status, res.text).toBe(302);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/auth/callback?return_to=/dashboard/billing`);
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("synapse_rt="));
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("HttpOnly");
    // The PKCE verifier reached the IdP
    expect(new URLSearchParams(idp.tokenCalls.at(-1)?.body ?? "").get("code_verifier")).toBeTruthy();

    const user = await userRow(email);
    expect(user).toBeDefined();
    expect(user?.identity_provider).toBe("keycloak");
    expect(user?.provider_subject).toBe(`kc-${email}`);
    expect(user?.password_hash).toBeNull(); // SSO-only: no local password

    // The refresh cookie mints a real session
    const token = /synapse_rt=([^;]+)/.exec(cookie ?? "")?.[1] as string;
    const refreshed = await h.http.post("/v1/auth/refresh").send({ refresh_token: decodeURIComponent(token) });
    expect(refreshed.status, refreshed.text).toBe(200);
    const me = await h.http.get("/v1/auth/me").set("Authorization", `Bearer ${refreshed.body.access_token as string}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it("sanitises return_to before it ever reaches the browser", async () => {
    const email = `sso-safe-${uid()}@example.com`;
    const { state, nonce } = await start("https://evil.test/phish");
    idp.nextToken = idToken(keypair, idp.issuer, { nonce, email, sub: `kc-${email}` });
    const res = await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state });
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/auth/callback?return_to=/dashboard`);
  });

  it("uses the state once, and answers 401 for a replay or an unknown one", async () => {
    const email = `sso-replay-${uid()}@example.com`;
    const { state, nonce } = await start();
    idp.nextToken = idToken(keypair, idp.issuer, { nonce, email, sub: `kc-${email}` });
    expect((await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state })).status).toBe(302);

    const replay = await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state });
    expect(replay.status).toBe(401);
    expect(String(replay.body.detail).toLowerCase()).toMatch(/unknown|expired/);
    expect((await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state: "nope" })).status).toBe(401);
  });

  it("links by subject, then by verified email, and keeps the local password", async () => {
    const email = `sso-link-${uid()}@example.com`;
    const subject = `kc-${email}`;
    // An existing LOCAL account with the same (verified) email gains SSO as a second door
    expect((await h.http.post("/v1/auth/register").send({ email, password: PASSWORD, display_name: "Local" })).status).toBe(201);

    let attempt = await start();
    idp.nextToken = idToken(keypair, idp.issuer, { nonce: attempt.nonce, email, sub: subject });
    expect((await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state: attempt.state })).status).toBe(302);
    const linked = await userRow(email);
    expect(linked?.provider_subject).toBe(subject);
    expect(linked?.password_hash).not.toBeNull(); // the password still works too

    // Next login: same subject, a different email at the IdP ⇒ still the same user
    attempt = await start();
    const renamed = `renamed-${uid()}@example.com`;
    idp.nextToken = idToken(keypair, idp.issuer, { nonce: attempt.nonce, email: renamed, sub: subject });
    expect((await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state: attempt.state })).status).toBe(302);
    expect(await userRow(renamed)).toBeUndefined();
    expect((await userRow(email))?.id).toBe(linked?.id);
  });

  it("an unverified email never takes over a local account", async () => {
    const email = `victim-${uid()}@example.com`;
    expect((await h.http.post("/v1/auth/register").send({ email, password: PASSWORD, display_name: "V" })).status).toBe(201);
    const { state, nonce } = await start();
    idp.nextToken = idToken(keypair, idp.issuer, { nonce, email, sub: `attacker-${uid()}`, email_verified: false });

    const res = await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state });
    expect(res.status, res.text).toBe(401);
    expect(res.body.reason).toBe("email_unverified");
    const victim = await userRow(email);
    expect(victim?.identity_provider).toBe("local");
    expect(victim?.provider_subject).toBeNull();
  });

  it("answers 401 on a nonce mismatch, a provider error, and a missing code", async () => {
    const { state } = await start();
    idp.nextToken = idToken(keypair, idp.issuer, { nonce: "not-the-one-we-sent" });
    const mismatch = await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state });
    expect(mismatch.status).toBe(401);
    expect(String(mismatch.body.detail)).toContain("nonce");

    expect((await h.http.get("/v1/auth/oidc/callback").query({ error: "access_denied", state: "x" })).status).toBe(401);
    expect((await h.http.get("/v1/auth/oidc/callback").query({ state: "x" })).status).toBe(401);
  });

  it("points an SSO-only account's password login at the flow that can sign it in", async () => {
    const email = `sso-only-${uid()}@example.com`;
    const { state, nonce } = await start();
    idp.nextToken = idToken(keypair, idp.issuer, { nonce, email, sub: `kc-${email}` });
    await h.http.get("/v1/auth/oidc/callback").query({ code: "c", state });

    const res = await h.http.post("/v1/auth/login").send({ email, password: "anything-at-all" });
    expect(res.status, res.text).toBe(401);
    expect(res.body.sso_url).toBe("/v1/auth/oidc/start");
    expect(res.body.identity_provider).toBe("keycloak");
  });
});
