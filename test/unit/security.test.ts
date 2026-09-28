import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../../src/core/config";
import { AuthenticationError } from "../../src/core/errors";
import { constantTimeEquals, DUMMY_PASSWORD_HASH, generateRefreshToken, SecurityService, sha256Hex, verifyPassword } from "../../src/core/security";

const settings = loadSettings({ SYNAPSE_SECRET_KEY: "unit-test-secret", SYNAPSE_ACCESS_TOKEN_TTL_MINUTES: "15" });
const security = new SecurityService(settings);

describe("passwords (argon2id, reference parameters)", () => {
  it("hashes with t=3, m=64MiB, p=4 and verifies", async () => {
    const hash = await security.hashPassword("password12345");
    expect(hash.startsWith("$argon2id$v=19$m=65536,t=3,p=4$")).toBe(true);
    expect(await security.verifyPassword("password12345", hash)).toBe(true);
    expect(await security.verifyPassword("password12346", hash)).toBe(false);
  });

  it("treats malformed hashes as a failed verification, never a throw", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe("access tokens (HS256, same claims as the reference)", () => {
  it("round-trips sub/email/org/platform_admin with iss and type", () => {
    const token = security.createAccessToken({
      userId: "3f5c1f3e-1b2a-4c5d-8e9f-0a1b2c3d4e5f",
      email: "a@example.com",
      organizationId: "org-1",
      isPlatformAdmin: true,
    });
    const claims = security.decodeAccessToken(token);
    expect(claims.sub).toBe("3f5c1f3e-1b2a-4c5d-8e9f-0a1b2c3d4e5f");
    expect(claims.org).toBe("org-1");
    expect(claims.platform_admin).toBe(true);
    expect(claims.iss).toBe("synapse-saas");
    expect(claims.type).toBe("access");
    expect(claims.exp - claims.iat).toBe(15 * 60);
    const raw = jwt.decode(token) as Record<string, unknown>;
    expect("org" in raw && "platform_admin" in raw).toBe(true);
  });

  it("omits org and platform_admin when not applicable", () => {
    const raw = jwt.decode(security.createAccessToken({ userId: "u", email: "e" })) as Record<string, unknown>;
    expect("org" in raw).toBe(false);
    expect("platform_admin" in raw).toBe(false);
  });

  it("rejects tampering, wrong secret, wrong type, wrong issuer, and expiry with one opaque error", () => {
    const good = security.createAccessToken({ userId: "u", email: "e" });
    expect(() => security.decodeAccessToken(`${good}x`)).toThrow(AuthenticationError);
    const other = new SecurityService(loadSettings({ SYNAPSE_SECRET_KEY: "other" })).createAccessToken({ userId: "u", email: "e" });
    expect(() => security.decodeAccessToken(other)).toThrow(AuthenticationError);
    const refreshTyped = jwt.sign({ sub: "u", type: "refresh", iss: "synapse-saas" }, "unit-test-secret", { algorithm: "HS256", expiresIn: 60 });
    expect(() => security.decodeAccessToken(refreshTyped)).toThrow(AuthenticationError);
    const badIssuer = jwt.sign({ sub: "u", type: "access", iss: "someone" }, "unit-test-secret", { algorithm: "HS256", expiresIn: 60 });
    expect(() => security.decodeAccessToken(badIssuer)).toThrow(AuthenticationError);
    const expired = security.createAccessToken({ userId: "u", email: "e", ttlSeconds: -10 });
    expect(() => security.decodeAccessToken(expired)).toThrow(AuthenticationError);
    const none = jwt.sign({ sub: "u", type: "access", iss: "synapse-saas" }, "", { algorithm: "none" });
    expect(() => security.decodeAccessToken(none)).toThrow(AuthenticationError);
  });
});

describe("opaque tokens", () => {
  it("generates 32 random bytes as base64url and hashes with sha256", () => {
    const token = generateRefreshToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(generateRefreshToken()).not.toBe(token);
  });

  it("compares in constant time without throwing on length mismatch", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "ab")).toBe(false);
  });
});
