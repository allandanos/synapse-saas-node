import { PERMISSIONS, SYSTEM_ROLES } from "../permissions";

/**
 * The OpenFGA authorization model, generated from the permission catalog
 * (ADR 0009 — transliterated from `authorization/fga_model.py`).
 *
 * RBAC stays the source of truth for what a role means (`permissions.ts`);
 * this module projects it into an OpenFGA model so the two can never disagree:
 *
 * - `type organization` carries one relation per system role (`owner`,
 *   `admin`, …) and one computed relation per permission
 *   (`can_org_delete`, …) that unions the roles holding it. Every `can_*`
 *   also accepts direct `[user]` tuples, so a custom role (any permission
 *   set) is expressible without per-tenant relations.
 * - `type project` is the resource-level template domain apps copy: `viewer`
 *   / `editor` inherit from the org's permission or are granted per object
 *   (sharing).
 *
 * `buildModel()` returns the JSON the OpenFGA API accepts; `renderDsl()`
 * renders the same model as the human-readable `.fga` DSL.
 */

export const SCHEMA_VERSION = "1.1";
export const ROLE_ORDER = ["owner", "admin", "billing", "developer", "member"] as const;

/** `org:delete` → `can_org_delete`. */
export function relationFor(permission: string): string {
  return `can_${permission.replace(/:/g, "_")}`;
}

/** The system roles granting `permission`, in `ROLE_ORDER`. */
export function rolesHolding(permission: string): string[] {
  return ROLE_ORDER.filter((role) => SYSTEM_ROLES[role]?.permissions.includes(permission));
}

// ── JSON (API) form ──────────────────────────────────────────────────────────

type Userset = Record<string, unknown>;

const direct = (): Userset => ({ this: {} });
const computed = (relation: string): Userset => ({ computedUserset: { relation } });
const tupleToUserset = (tupleset: string, relation: string): Userset => ({
  tupleToUserset: { tupleset: { relation: tupleset }, computedUserset: { relation } },
});
const union = (...children: Userset[]): Userset => (children.length === 1 ? (children[0] as Userset) : { union: { child: children } });

function userType(): Userset {
  return { type: "user", relations: {}, metadata: null };
}

function organizationType(): Userset {
  const relations: Record<string, Userset> = {};
  const metadata: Record<string, Userset> = {};
  for (const role of ROLE_ORDER) {
    relations[role] = direct();
    metadata[role] = { directly_related_user_types: [{ type: "user" }] };
  }
  for (const permission of PERMISSIONS) {
    const relation = relationFor(permission.key);
    relations[relation] = union(direct(), ...rolesHolding(permission.key).map((role) => computed(role)));
    metadata[relation] = { directly_related_user_types: [{ type: "user" }] };
  }
  return { type: "organization", relations, metadata: { relations: metadata } };
}

function projectType(): Userset {
  return {
    type: "project",
    relations: {
      org: direct(),
      viewer: union(direct(), computed("editor"), tupleToUserset("org", relationFor("project:read"))),
      editor: union(direct(), tupleToUserset("org", relationFor("project:manage"))),
    },
    metadata: {
      relations: {
        org: { directly_related_user_types: [{ type: "organization" }] },
        viewer: { directly_related_user_types: [{ type: "user" }] },
        editor: { directly_related_user_types: [{ type: "user" }] },
      },
    },
  };
}

/** The authorization model in the OpenFGA API's JSON form. */
export function buildModel(): { schema_version: string; type_definitions: Userset[] } {
  return { schema_version: SCHEMA_VERSION, type_definitions: [userType(), organizationType(), projectType()] };
}

// ── DSL form (for humans) ────────────────────────────────────────────────────

export function renderDsl(): string {
  const lines = ["model", `  schema ${SCHEMA_VERSION}`, "", "type user", "", "type organization", "  relations"];
  for (const role of ROLE_ORDER) lines.push(`    define ${role}: [user]`);
  for (const permission of PERMISSIONS) {
    const holders = rolesHolding(permission.key).join(" or ");
    lines.push(`    define ${relationFor(permission.key)}: [user]${holders ? ` or ${holders}` : ""}`);
  }
  lines.push(
    "",
    "type project",
    "  relations",
    "    define org: [organization]",
    `    define viewer: [user] or editor or ${relationFor("project:read")} from org`,
    `    define editor: [user] or ${relationFor("project:manage")} from org`,
    "",
  );
  return lines.join("\n");
}
