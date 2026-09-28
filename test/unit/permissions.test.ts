import { describe, expect, it } from "vitest";
import {
  compareRoles,
  PERMISSION_KEYS,
  PERMISSIONS,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLES,
  unknownPermissions,
} from "../../src/authorization/permissions";

describe("permission catalog (transliterated from the reference)", () => {
  it("has the 21 resource:action keys, unique and well-formed", () => {
    expect(PERMISSIONS).toHaveLength(21);
    expect(PERMISSION_KEYS.size).toBe(21);
    for (const p of PERMISSIONS) {
      expect(p.key).toBe(`${p.resource}:${p.action}`);
      expect(p.description.length).toBeGreaterThan(0);
    }
    expect(PERMISSION_KEYS.has("org:read")).toBe(true);
    expect(PERMISSION_KEYS.has("agents:manage")).toBe(true);
  });

  it("defines the five system roles with sorted, catalog-only permissions", () => {
    expect(SYSTEM_ROLE_KEYS).toEqual(["owner", "admin", "billing", "developer", "member"]);
    for (const role of Object.values(SYSTEM_ROLES)) {
      expect([...role.permissions]).toEqual([...role.permissions].sort());
      expect(unknownPermissions(role.permissions)).toEqual([]);
    }
  });

  it("owner holds everything but entitlement:manage; admin also lacks org:delete", () => {
    const owner = new Set(SYSTEM_ROLES.owner.permissions);
    expect(owner.size).toBe(20);
    expect(owner.has("entitlement:manage")).toBe(false);
    const admin = new Set(SYSTEM_ROLES.admin.permissions);
    expect(admin.size).toBe(19);
    expect(admin.has("org:delete")).toBe(false);
  });

  it("no tenant system role carries the operator permission (ADR 0008)", () => {
    expect(PERMISSION_KEYS.has("entitlement:manage")).toBe(true);
    for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
      expect(role.permissions.includes("entitlement:manage"), key).toBe(false);
    }
  });

  it("pins the narrow roles", () => {
    expect(SYSTEM_ROLES.billing.permissions).toEqual(["billing:manage", "billing:read", "org:read", "usage:read"]);
    expect(SYSTEM_ROLES.member.permissions).toEqual(["org:read", "project:read"]);
    expect(SYSTEM_ROLES.developer.permissions).toEqual([
      "agents:read",
      "apikey:manage",
      "member:read",
      "org:read",
      "project:manage",
      "project:read",
      "usage:read",
      "webhook:manage",
    ]);
  });

  it("orders roles system-first then by key, like GET /v1/roles", () => {
    const roles = [
      { key: "aud", is_system: false },
      { key: "owner", is_system: true },
      { key: "admin", is_system: true },
      { key: "abc", is_system: false },
    ];
    expect([...roles].sort(compareRoles).map((r) => r.key)).toEqual(["admin", "owner", "abc", "aud"]);
  });

  it("reports unknown permissions sorted and de-duplicated", () => {
    expect(unknownPermissions(["org:read", "nope:nope", "zzz:1", "nope:nope"])).toEqual(["nope:nope", "zzz:1"]);
  });
});
