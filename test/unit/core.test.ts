import { describe, expect, it } from "vitest";
import { loadSettings } from "../../src/core/config";
import { audienceFor, events } from "../../src/core/events";
import { isUuid, isValidSlug, RESERVED_SLUGS, slugify, uniqueSlug, uuidV7, uuidV7Timestamp } from "../../src/core/ids";
import { flattenValidationErrors } from "../../src/core/validation";

describe("settings", () => {
  it("derives the reference's computed properties", () => {
    const s = loadSettings({
      SYNAPSE_WEB_ORIGIN: "https://console.example.com",
      SYNAPSE_WEB_ORIGINS: "https://a.example.com, https://console.example.com,https://b.example.com",
      SYNAPSE_TENANT_ISOLATION: "app_and_rls",
      SYNAPSE_REFRESH_TOKEN_TTL_DAYS: "7",
    });
    expect(s.rlsEnabled).toBe(true);
    expect(s.cookieSecure).toBe(true);
    expect(s.corsOrigins).toEqual(["https://console.example.com", "https://a.example.com", "https://b.example.com"]);
    expect(s.refreshTokenTtlSeconds).toBe(7 * 86_400);
    expect(s.accessTokenTtlSeconds).toBe(900);
    expect(loadSettings({ SYNAPSE_WEB_ORIGINS: '["https://x"]' }).SYNAPSE_WEB_ORIGINS).toEqual(["https://x"]);
    expect(loadSettings({ SYNAPSE_COOKIE_SECURE: "false", SYNAPSE_WEB_ORIGIN: "https://x" }).cookieSecure).toBe(false);
  });

  it("refuses the dev secret in production", () => {
    expect(() => loadSettings({ SYNAPSE_ENV: "production" })).toThrow(/SYNAPSE_SECRET_KEY/);
    expect(loadSettings({ SYNAPSE_ENV: "production", SYNAPSE_SECRET_KEY: "real-secret" }).isProduction).toBe(true);
  });

  it("normalises the reference's asyncpg DSN", () => {
    expect(loadSettings({ SYNAPSE_DATABASE_URL: "postgresql+asyncpg://u:p@h:5432/db" }).SYNAPSE_DATABASE_URL).toBe("postgresql://u:p@h:5432/db");
  });
});

describe("ids", () => {
  it("uuidV7 is version 7, RFC variant, time-ordered", () => {
    const a = uuidV7(1_700_000_000_000);
    const b = uuidV7(1_700_000_000_001);
    expect(isUuid(a)).toBe(true);
    expect(a[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(a[19]);
    expect(a < b).toBe(true);
    expect(uuidV7Timestamp(a).getTime()).toBe(1_700_000_000_000);
  });

  it("slugify / isValidSlug / uniqueSlug follow the reference rules", () => {
    expect(slugify("  Acme, Inc. — Europe! ")).toBe("acme-inc-europe");
    expect(slugify("x".repeat(60))).toHaveLength(48);
    expect(isValidSlug("org-1234")).toBe(true);
    expect(isValidSlug("ab")).toBe(false); // 1 or 3..48 chars
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("-bad")).toBe(false);
    expect(isValidSlug("admin")).toBe(false);
    expect(RESERVED_SLUGS.has("api")).toBe(true);
    expect(uniqueSlug("Acme Inc")).toMatch(/^acme-inc-[0-9a-f]{6}$/);
    expect(uniqueSlug("!!!")).toMatch(/^org-[0-9a-f]{6}$/);
  });
});

describe("events", () => {
  it("stamps credential-bearing events internal and everything else public", () => {
    expect(audienceFor(events.MEMBER_INVITE_EMAIL)).toBe("internal");
    expect(audienceFor(events.USER_PASSWORD_RESET_LINK)).toBe("internal");
    expect(audienceFor(events.MEMBER_INVITED)).toBe("public");
    expect(audienceFor(events.ORG_CREATED)).toBe("public");
  });
});

describe("validation flattening", () => {
  it("turns nested class-validator errors into loc/msg/type issues", () => {
    const issues = flattenValidationErrors(
      [
        { property: "email", constraints: { isEmail: "email must be an email" }, children: [] },
        {
          property: "nested",
          children: [{ property: "limit", constraints: { min: "limit must not be less than 1" } }],
        },
      ],
      "body",
    );
    expect(issues).toEqual([
      { loc: ["body", "email"], msg: "email must be an email", type: "isEmail" },
      { loc: ["body", "nested", "limit"], msg: "limit must not be less than 1", type: "min" },
    ]);
  });
});
