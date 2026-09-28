import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { TenantNotResolvedError } from "../../src/core/errors";
import type { UserContext } from "../../src/core/request-context";
import { resolveOrgReference } from "../../src/tenancy/tenant.guard";

const ORG = "3f5c1f3e-1b2a-4c5d-8e9f-0a1b2c3d4e5f";
const user = (orgClaim: string | null = null): UserContext => ({
  userId: "u",
  email: "u@example.com",
  isPlatformAdmin: false,
  permissionKeys: new Set(),
  orgClaim,
  apiKeyId: null,
  apiKeyScopes: null,
  apiKeyCreatorId: null,
});
const req = (headers: Record<string, string>): Request => ({ headers }) as unknown as Request;

describe("tenant resolution order: X-Org-Id → X-Org-Slug → subdomain → JWT org claim", () => {
  it("prefers the id header and rejects a malformed one as 404", () => {
    expect(resolveOrgReference(req({ "x-org-id": ORG, "x-org-slug": "acme", host: "acme.example.com" }), user())).toEqual({ kind: "id", value: ORG });
    expect(() => resolveOrgReference(req({ "x-org-id": "nope" }), user())).toThrow(TenantNotResolvedError);
  });

  it("then the slug header, then the subdomain (skipping www/api/app and IP literals)", () => {
    expect(resolveOrgReference(req({ "x-org-slug": "acme", host: "other.example.com" }), user())).toEqual({ kind: "slug", value: "acme" });
    expect(resolveOrgReference(req({ host: "acme.app.example.com:8090" }), user())).toEqual({ kind: "slug", value: "acme" });
    expect(resolveOrgReference(req({ host: "app.example.com" }), user())).toBeNull();
    expect(resolveOrgReference(req({ host: "127.0.0.1:8090" }), user())).toBeNull();
    expect(resolveOrgReference(req({ host: "localhost:8090" }), user())).toBeNull();
  });

  it("falls back to the JWT org claim and to nothing", () => {
    expect(resolveOrgReference(req({ host: "localhost" }), user(ORG))).toEqual({ kind: "id", value: ORG });
    expect(resolveOrgReference(req({ host: "localhost" }), user("garbage"))).toBeNull();
    expect(resolveOrgReference(req({}), user())).toBeNull();
  });
});
