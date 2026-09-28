import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  DomainError,
  OrganizationSuspendedError,
  PermissionDeniedError,
  TenantNotResolvedError,
  ValidationFailedError,
} from "../../src/core/errors";

describe("problem documents (RFC 7807 + contracts/problems.json)", () => {
  it("renders type/title/status/detail/instance/request_id", () => {
    const doc = new OrganizationSuspendedError("Organization is suspended", {
      organization_id: "org-1",
      organization_status: "suspended",
    }).toProblem({ instance: "/v1/orgs/current", requestId: "req_abc" });
    expect(doc).toEqual({
      organization_id: "org-1",
      organization_status: "suspended",
      type: "https://synapse-saas.dev/problems/organization_suspended",
      title: "organization suspended",
      status: 403,
      detail: "Organization is suspended",
      instance: "/v1/orgs/current",
      request_id: "req_abc",
    });
  });

  it("never lets an extra shadow an RFC 7807 member", () => {
    const doc = new PermissionDeniedError("nope", { status: 200, type: "x", title: "y", detail: "z", request_id: "fake" }).toProblem({
      requestId: "req_real",
    });
    expect(doc.status).toBe(403);
    expect(doc.type).toBe("https://synapse-saas.dev/problems/permission_denied");
    expect(doc.title).toBe("permission denied");
    expect(doc.detail).toBe("nope");
    expect(doc.request_id).toBe("req_real");
  });

  it("falls back to the title as detail and omits absent members", () => {
    const doc = new AuthenticationError().toProblem();
    expect(doc.detail).toBe("unauthorized");
    expect("instance" in doc).toBe(false);
    expect("request_id" in doc).toBe(false);
  });

  it("maps identical titles for the deliberately indistinguishable 404s", () => {
    expect(new TenantNotResolvedError().problemType).toBe("https://synapse-saas.dev/problems/not_found");
    expect(new TenantNotResolvedError()).toBeInstanceOf(DomainError);
  });

  it("summarises validation failures with the first three fields", () => {
    const err = new ValidationFailedError([
      { loc: ["body", "email"], msg: "must be an email", type: "isEmail" },
      { loc: ["body", "password"], msg: "too short", type: "minLength" },
      { loc: ["body", "display_name"], msg: "required", type: "isString" },
      { loc: ["query", "limit"], msg: "min", type: "min" },
    ]);
    const doc = err.toProblem();
    expect(doc.status).toBe(422);
    expect(doc.title).toBe("validation failed");
    expect(doc.detail).toBe("Invalid request: email, password, display_name");
    expect(doc.errors).toHaveLength(4);
  });
});
