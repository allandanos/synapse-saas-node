import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FgaClient, type FgaTuple } from "../../src/authorization/fga/client";
import { buildModel, relationFor, ROLE_ORDER, rolesHolding, renderDsl } from "../../src/authorization/fga/model";
import { desiredTuples, orgObject, userObject } from "../../src/authorization/fga/sync";
import { PERMISSIONS, SYSTEM_ROLES } from "../../src/authorization/permissions";
import { loadSettings } from "../../src/core/config";
import { FgaError } from "../../src/core/errors";
import { StubProviderServer } from "../support/stub-provider-server";

type TypeDefinition = { type: string; relations: Record<string, Record<string, unknown>>; metadata: { relations: Record<string, { directly_related_user_types: unknown[] }> } };

const typeDef = (name: string): TypeDefinition => buildModel().type_definitions.find((t) => (t as TypeDefinition).type === name) as unknown as TypeDefinition;

/** The roles a `can_*` relation unions in. */
function computedRoles(definition: Record<string, unknown>): Set<string> {
  const children = ((definition.union as { child?: Record<string, unknown>[] } | undefined)?.child ?? [definition]) as Record<string, unknown>[];
  return new Set(
    children
      .filter((child) => "computedUserset" in child)
      .map((child) => (child.computedUserset as { relation: string }).relation),
  );
}

describe("the generated model mirrors the permission catalog", () => {
  it("gives every permission a relation", () => {
    const relations = typeDef("organization").relations;
    for (const permission of PERMISSIONS) expect(relations, permission.key).toHaveProperty(relationFor(permission.key));
  });

  it("gives every system role a relation", () => {
    const relations = typeDef("organization").relations;
    expect(new Set(ROLE_ORDER)).toEqual(new Set(Object.keys(SYSTEM_ROLES)));
    for (const role of ROLE_ORDER) expect(relations).toHaveProperty(role);
  });

  it("unions a role into can_* exactly when RBAC grants it", () => {
    const relations = typeDef("organization").relations;
    const mismatches: [string, string][] = [];
    for (const role of ROLE_ORDER) {
      const granted = new Set(SYSTEM_ROLES[role]?.permissions ?? []);
      for (const permission of PERMISSIONS) {
        const roles = computedRoles(relations[relationFor(permission.key)] as Record<string, unknown>);
        if (roles.has(role) !== granted.has(permission.key)) mismatches.push([role, permission.key]);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("lets a custom role grant any permission directly", () => {
    const metadata = typeDef("organization").metadata.relations;
    for (const permission of PERMISSIONS) {
      expect(metadata[relationFor(permission.key)]?.directly_related_user_types).toEqual([{ type: "user" }]);
    }
  });

  it("leaves the operator permission role-less (ADR 0008)", () => {
    expect(rolesHolding("entitlement:manage")).toEqual([]);
  });

  it("carries the project template with org inheritance", () => {
    const project = typeDef("project");
    expect(new Set(Object.keys(project.relations))).toEqual(new Set(["org", "viewer", "editor"]));
    const viewer = (project.relations.viewer as { union: { child: Record<string, unknown>[] } }).union.child;
    expect(viewer.some((child) => "tupleToUserset" in child)).toBe(true);
  });

  it("is JSON-serialisable", () => {
    expect(() => JSON.stringify(buildModel())).not.toThrow();
  });
});

describe("the DSL renders the same model", () => {
  it("matches the reference's `render_dsl()` byte for byte", () => {
    const fixture = readFileSync(join(__dirname, "..", "fixtures", "fga-model.fga"), "utf8");
    expect(renderDsl()).toBe(fixture);
  });

  it("spells out the catalog", () => {
    const dsl = renderDsl();
    expect(dsl.startsWith("model\n  schema 1.1")).toBe(true);
    for (const permission of PERMISSIONS) expect(dsl).toContain(`define ${relationFor(permission.key)}: [user]`);
    expect(dsl).toContain("define can_org_delete: [user] or owner\n");
    expect(dsl).toContain("define can_billing_read: [user] or owner or admin or billing\n");
    expect(dsl).toContain("define viewer: [user] or editor or can_project_read from org");
  });
});

describe("desiredTuples", () => {
  const user = "11111111-1111-1111-1111-111111111111";
  const org = "22222222-2222-2222-2222-222222222222";
  const ids = (tuples: FgaTuple[]): string[] => tuples.map((t) => `${t.user}|${t.relation}|${t.object}`).sort();

  it("turns a system role into one role tuple, permissions included", () => {
    const tuples = desiredTuples({ userId: user, organizationId: org, roleKeys: ["admin"], permissionKeys: ["org:read", "org:update"] });
    expect(ids(tuples)).toEqual([`${userObject(user)}|admin|${orgObject(org)}`]);
  });

  it("writes a custom role's extra permissions as direct grants", () => {
    const tuples = desiredTuples({
      userId: user,
      organizationId: org,
      roleKeys: ["member", "auditor"], // auditor is a custom role granting audit:read
      permissionKeys: ["org:read", "project:read", "audit:read"],
    });
    expect(ids(tuples)).toEqual([`${userObject(user)}|can_audit_read|${orgObject(org)}`, `${userObject(user)}|member|${orgObject(org)}`].sort());
  });

  it("gives a member with no roles no tuples", () => {
    expect(desiredTuples({ userId: user, organizationId: org, roleKeys: [], permissionKeys: [] })).toEqual([]);
  });
});

describe("FgaClient", () => {
  const settingsFor = (url: string, storeId = "st"): ReturnType<typeof loadSettings> =>
    loadSettings({ SYNAPSE_OPENFGA_URL: url, SYNAPSE_OPENFGA_STORE_ID: storeId });

  it("posts a check with the catalog relation and reads `allowed`", async () => {
    const stub = new StubProviderServer({ "POST /stores/st/check": { json: { allowed: true } } });
    const url = await stub.start();
    try {
      const client = new FgaClient(settingsFor(url));
      expect(await client.check("user:u1", "can_org_delete", "organization:o1")).toBe(true);
      expect(JSON.parse(stub.calls[0]?.body ?? "{}")).toEqual({ tuple_key: { user: "user:u1", relation: "can_org_delete", object: "organization:o1" } });
    } finally {
      await stub.stop();
    }
  });

  it("pins the model id on every request when one is configured", async () => {
    const stub = new StubProviderServer({ "POST /stores/st/check": { json: { allowed: false } } });
    const url = await stub.start();
    try {
      const settings = loadSettings({ SYNAPSE_OPENFGA_URL: url, SYNAPSE_OPENFGA_STORE_ID: "st", SYNAPSE_OPENFGA_MODEL_ID: "m1" });
      expect(await new FgaClient(settings).check("user:u1", "can_org_read", "organization:o1")).toBe(false);
      expect(JSON.parse(stub.calls[0]?.body ?? "{}").authorization_model_id).toBe("m1");
    } finally {
      await stub.stop();
    }
  });

  it("sends the bearer token when one is configured", async () => {
    const stub = new StubProviderServer({ "POST /stores/st/check": { json: { allowed: true } } });
    const url = await stub.start();
    try {
      const settings = loadSettings({ SYNAPSE_OPENFGA_URL: url, SYNAPSE_OPENFGA_STORE_ID: "st", SYNAPSE_OPENFGA_API_TOKEN: "t0k3n" });
      await new FgaClient(settings).check("user:u1", "can_org_read", "organization:o1");
      expect(stub.calls[0]?.headers.authorization).toBe("Bearer t0k3n");
    } finally {
      await stub.stop();
    }
  });

  it("writes one request per tuple and tolerates duplicates and missing deletes", async () => {
    // OpenFGA answers 400 with "already exists" / "not found"; both are fine.
    let call = 0;
    const stub = new StubProviderServer({
      "POST /stores/st/write": {
        status: 400,
        get json(): unknown {
          call += 1;
          return { message: call === 1 ? "tuple already exists" : "tuple not found" };
        },
      },
    });
    const url = await stub.start();
    try {
      const client = new FgaClient(settingsFor(url));
      await expect(
        client.write([{ user: "user:u1", relation: "member", object: "organization:o1" }], [{ user: "user:u1", relation: "admin", object: "organization:o1" }]),
      ).resolves.toBeUndefined();
      expect(stub.calls).toHaveLength(2);
    } finally {
      await stub.stop();
    }
  });

  it("turns any other non-2xx into FgaError", async () => {
    const stub = new StubProviderServer({ "POST /stores/st/write": { status: 500, json: { message: "boom" } } });
    const url = await stub.start();
    try {
      await expect(new FgaClient(settingsFor(url)).write([{ user: "user:u1", relation: "member", object: "organization:o1" }])).rejects.toBeInstanceOf(FgaError);
    } finally {
      await stub.stop();
    }
  });

  it("turns an unreachable store into FgaError", async () => {
    // Port 1 is reserved and never listening.
    await expect(new FgaClient(settingsFor("http://127.0.0.1:1")).check("user:u1", "can_org_read", "organization:o1")).rejects.toBeInstanceOf(FgaError);
  });

  it("refuses to build a store path without a store id", () => {
    expect(new FgaClient(settingsFor("http://fga.test", "")).configured).toBe(false);
  });

  it("reads tuples back on an object", async () => {
    const stub = new StubProviderServer({
      "POST /stores/st/read": { json: { tuples: [{ key: { user: "user:u1", relation: "member", object: "organization:o1" } }] } },
    });
    const url = await stub.start();
    try {
      expect(await new FgaClient(settingsFor(url)).readTuples("organization:o1")).toEqual([{ user: "user:u1", relation: "member", object: "organization:o1" }]);
    } finally {
      await stub.stop();
    }
  });
});
