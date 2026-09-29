import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadSettings } from "../../src/core/config";
import { clearJwksCache } from "../../src/identity/oidc/jwks";
import { KeycloakProvider, LocalIdentityProvider, OIDC_SCOPE, createIdentityProvider } from "../../src/identity/oidc/identity-provider";
import { codeChallenge, newLoginAttempt, safeReturnTo } from "../../src/identity/oidc/pkce";
import { idToken, makeKeypair, StubIdp } from "../support/stub-idp";

const idp = new StubIdp();
const keypair = makeKeypair();

function provider(env: Record<string, string> = {}): KeycloakProvider {
  return new KeycloakProvider(
    loadSettings({
      SYNAPSE_IDENTITY_PROVIDER: "keycloak",
      SYNAPSE_KEYCLOAK_BASE_URL: idp.origin,
      SYNAPSE_KEYCLOAK_REALM: "synapse",
      SYNAPSE_KEYCLOAK_CLIENT_ID: "synapse-web",
      SYNAPSE_KEYCLOAK_CLIENT_SECRET: "secret",
      ...env,
    }),
  );
}

beforeAll(async () => {
  await idp.start();
  idp.keys = [keypair.jwk];
});

afterAll(async () => {
  await idp.stop();
});

afterEach(() => {
  clearJwksCache();
  idp.certsCalls = 0;
  idp.tokenStatus = 200;
  idp.keys = [keypair.jwk];
  idp.tokenCalls.length = 0;
});

describe("provider selection", () => {
  it("reads SYNAPSE_IDENTITY_PROVIDER", () => {
    expect(createIdentityProvider(loadSettings({ SYNAPSE_IDENTITY_PROVIDER: "keycloak" })).name).toBe("keycloak");
    expect(createIdentityProvider(loadSettings({})).name).toBe("local");
  });

  it("the local provider refuses both SSO entry points", () => {
    const local = new LocalIdentityProvider();
    expect(() => local.authorizationUrl()).toThrow(/SSO is not available/);
    expect(() => local.exchangeCode()).toThrow(/OIDC is not available/);
  });

  it("an unconfigured Keycloak says so instead of building a broken URL", async () => {
    const bare = new KeycloakProvider(loadSettings({ SYNAPSE_IDENTITY_PROVIDER: "keycloak" }));
    await expect(bare.exchangeCode("c", { redirectUri: "r" })).rejects.toThrow(/not configured/);
  });
});

describe("PKCE", () => {
  it("derives an S256 challenge and fresh, long entropy per attempt", () => {
    const a = newLoginAttempt();
    const b = newLoginAttempt();
    expect(a.state).not.toBe(b.state);
    expect(a.state.length).toBeGreaterThanOrEqual(32);
    expect(a.nonce.length).toBeGreaterThanOrEqual(16);
    expect(a.challenge).toBe(codeChallenge(a.verifier));
    expect(a.challenge).not.toContain("="); // base64url, unpadded
  });

  it("neutralises open redirects", () => {
    expect(safeReturnTo("/dashboard/billing")).toBe("/dashboard/billing");
    expect(safeReturnTo("https://evil.test/phish")).toBe("/dashboard");
    expect(safeReturnTo("//evil.test/phish")).toBe("/dashboard");
    expect(safeReturnTo(null)).toBe("/dashboard");
  });
});

describe("the authorization URL", () => {
  it("carries the client, PKCE, state and nonce", () => {
    const url = new URL(provider().authorizationUrl({ redirectUri: "https://api.example.test/v1/auth/oidc/callback", state: "st", nonce: "nn", codeChallenge: "chal" }));
    expect(url.pathname).toBe("/realms/synapse/protocol/openid-connect/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "synapse-web",
      response_type: "code",
      scope: OIDC_SCOPE,
      redirect_uri: "https://api.example.test/v1/auth/oidc/callback",
      state: "st",
      nonce: "nn",
      code_challenge: "chal",
      code_challenge_method: "S256",
    });
  });
});

describe("the code exchange", () => {
  it("verifies signature, issuer, audience and nonce, and sends the PKCE verifier", async () => {
    idp.nextToken = idToken(keypair, idp.issuer, { nonce: "n-1" });
    const claims = await provider().exchangeCode("code-123", { redirectUri: "https://app.example.test/callback", codeVerifier: "ver-1", nonce: "n-1" });
    expect(claims.sub).toBe("kc-sub-1");
    expect(claims.email).toBe("sso@example.com");
    const sent = new URLSearchParams(idp.tokenCalls.at(-1)?.body ?? "");
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBe("ver-1");
    expect(sent.get("client_secret")).toBe("secret");
  });

  it("rejects a bad code", async () => {
    idp.tokenStatus = 400;
    await expect(provider().exchangeCode("bad", { redirectUri: "r" })).rejects.toThrow(/code exchange failed/);
  });

  it("rejects a token response with no id_token", async () => {
    idp.nextToken = null;
    await expect(provider().exchangeCode("c", { redirectUri: "r" })).rejects.toThrow(/no id_token/);
  });

  it("rejects a nonce mismatch", async () => {
    idp.nextToken = idToken(keypair, idp.issuer, { nonce: "expected" });
    await expect(provider().exchangeCode("c", { redirectUri: "r", nonce: "other" })).rejects.toThrow(/nonce/);
  });

  it("rejects the wrong issuer", async () => {
    idp.nextToken = idToken(keypair, "https://evil.example.test/realms/synapse");
    await expect(provider().exchangeCode("c", { redirectUri: "r" })).rejects.toThrow(/rejected/);
  });

  it("rejects the wrong audience", async () => {
    idp.nextToken = idToken(keypair, idp.issuer, { aud: "another-client" });
    await expect(provider().exchangeCode("c", { redirectUri: "r" })).rejects.toThrow(/rejected/);
  });

  it("rejects an expired token", async () => {
    idp.nextToken = idToken(keypair, idp.issuer, { exp: 1 });
    await expect(provider().exchangeCode("c", { redirectUri: "r" })).rejects.toThrow(/rejected/);
  });

  it("rejects a token signed by a key the realm does not publish", async () => {
    const attacker = makeKeypair("test-key"); // same kid, different key
    idp.nextToken = idToken(attacker, idp.issuer);
    await expect(provider().exchangeCode("c", { redirectUri: "r" })).rejects.toThrow(/rejected/);
  });

  it("rejects a token missing a required claim", async () => {
    // A token with no expiry would never age out: the reference requires exp/iat/sub.
    idp.nextToken = idToken(keypair, idp.issuer, { exp: null });
    await expect(provider().exchangeCode("c", { redirectUri: "r" })).rejects.toThrow(/missing 'exp'/);
  });

  it("caches the JWKS and refetches once on an unknown kid", async () => {
    const kc = provider();
    idp.nextToken = idToken(keypair, idp.issuer);
    await kc.exchangeCode("c1", { redirectUri: "r" });
    await kc.exchangeCode("c2", { redirectUri: "r" });
    expect(idp.certsCalls).toBe(1); // the second login is served from the cache

    // A rotated key: the token's kid is unknown ⇒ one refetch, then it verifies
    const rotated = makeKeypair("rotated");
    idp.keys = [keypair.jwk, rotated.jwk];
    idp.nextToken = idToken(rotated, idp.issuer, { sub: "kc-sub-2", email: "x@example.com" });
    const claims = await kc.exchangeCode("c3", { redirectUri: "r" });
    expect(claims.sub).toBe("kc-sub-2");
    expect(idp.certsCalls).toBe(2);
  });

  it("gives up when no key matches even after the refetch", async () => {
    const orphan = makeKeypair("never-published");
    idp.nextToken = idToken(orphan, idp.issuer);
    await expect(provider().exchangeCode("c", { redirectUri: "r" })).rejects.toThrow(/No matching Keycloak signing key/);
    expect(idp.certsCalls).toBe(2); // cached, then refetched once
  });
});

describe("the password grant", () => {
  it("is refused unless explicitly enabled", async () => {
    idp.nextToken = idToken(keypair, idp.issuer);
    expect(await provider().verifyCredentials("a@b.c", "pw")).toBeNull();
    expect(idp.tokenCalls).toHaveLength(0);
  });

  it("works when enabled", async () => {
    idp.nextToken = idToken(keypair, idp.issuer);
    const claims = await provider({ SYNAPSE_KEYCLOAK_ALLOW_PASSWORD_GRANT: "true" }).verifyCredentials("a@b.c", "pw");
    expect(claims?.sub).toBe("kc-sub-1");
    expect(new URLSearchParams(idp.tokenCalls.at(-1)?.body ?? "").get("grant_type")).toBe("password");
  });

  it("answers null (never throws) on bad credentials", async () => {
    idp.tokenStatus = 401;
    expect(await provider({ SYNAPSE_KEYCLOAK_ALLOW_PASSWORD_GRANT: "true" }).verifyCredentials("a@b.c", "pw")).toBeNull();
  });
});
