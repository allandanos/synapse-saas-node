/**
 * Canonical permission catalog — transliterated from the reference's
 * `authorization/permissions.py`, the single source of truth seeded into the
 * `permissions` table and referenced by `@RequirePermission()`.
 */

export interface PermissionDef {
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
}

const def = (key: string, description: string): PermissionDef => {
  const [resource, action] = key.split(":") as [string, string];
  return { key, resource, action, description };
};

export const PERMISSIONS: readonly PermissionDef[] = [
  // Organization
  def("org:read", "View organization details"),
  def("org:update", "Update organization profile and settings"),
  def("org:delete", "Delete the organization"),
  // Members
  def("member:read", "List members and their roles"),
  def("member:invite", "Invite new members"),
  def("member:update", "Change member roles and status"),
  def("member:remove", "Remove members from the organization"),
  // Roles
  def("role:manage", "Create, update, and delete custom roles"),
  // Billing & subscription
  def("billing:read", "View subscription, plans, and invoices"),
  def("billing:manage", "Change plans, start trials, manage payment"),
  // Usage & audit
  def("usage:read", "View usage meters and limits"),
  def("audit:read", "View the organization audit log"),
  // Webhooks
  def("webhook:manage", "Manage webhook endpoints and view deliveries"),
  // Entitlements
  def("entitlement:manage", "Grant or revoke feature entitlements (operator)"),
  def("apikey:manage", "Create, list, and revoke API keys"),
  // Files
  def("file:read", "List and download organization files"),
  def("file:write", "Upload and delete organization files"),
  // Project-scoped example (the pattern domain apps extend)
  def("project:read", "View projects"),
  def("project:manage", "Create, update, and delete projects"),
  // Agents (registry governance — ADR 0007)
  def("agents:read", "View registered agents"),
  def("agents:manage", "Register, update, enable/disable agents"),
];

export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

// ── System roles ───────────────────────────────────────────────────────────────

export const SYSTEM_ROLE_OWNER = "owner";
export const SYSTEM_ROLE_ADMIN = "admin";
export const SYSTEM_ROLE_BILLING = "billing";
export const SYSTEM_ROLE_DEVELOPER = "developer";
export const SYSTEM_ROLE_MEMBER = "member";

export interface SystemRoleDef {
  readonly name: string;
  readonly description: string;
  /** Sorted permission keys. */
  readonly permissions: readonly string[];
}

const sorted = (keys: Iterable<string>): readonly string[] => [...keys].sort();

// entitlement:manage is an OPERATOR permission: a tenant must never be able to
// grant itself features or raise its own limits. It stays in the catalog for
// platform-operator roles; no tenant system role carries it.
const OWNER = new Set([...PERMISSION_KEYS].filter((k) => k !== "entitlement:manage"));
const ADMIN = new Set([...OWNER].filter((k) => k !== "org:delete"));
const BILLING = new Set(["org:read", "billing:read", "billing:manage", "usage:read"]);
const DEVELOPER = new Set([
  "org:read",
  "member:read",
  "project:read",
  "project:manage",
  "webhook:manage",
  "usage:read",
  "apikey:manage",
  "agents:read",
]);
const MEMBER = new Set(["org:read", "project:read"]);

export const SYSTEM_ROLES: Readonly<Record<string, SystemRoleDef>> = {
  [SYSTEM_ROLE_OWNER]: {
    name: "Owner",
    description: "Full control, including deleting the organization",
    permissions: sorted(OWNER),
  },
  [SYSTEM_ROLE_ADMIN]: {
    name: "Admin",
    description: "Manage everything except deleting the organization",
    permissions: sorted(ADMIN),
  },
  [SYSTEM_ROLE_BILLING]: {
    name: "Billing",
    description: "Manage subscription, plans, and invoices",
    permissions: sorted(BILLING),
  },
  [SYSTEM_ROLE_DEVELOPER]: {
    name: "Developer",
    description: "Build on the platform: projects, webhooks, usage visibility",
    permissions: sorted(DEVELOPER),
  },
  [SYSTEM_ROLE_MEMBER]: {
    name: "Member",
    description: "Day-to-day access to org resources",
    permissions: sorted(MEMBER),
  },
};

export const SYSTEM_ROLE_KEYS: readonly string[] = Object.keys(SYSTEM_ROLES);

/** Role listing order: system roles first, then by key — what `GET /v1/roles` returns. */
export function compareRoles(a: { is_system: boolean; key: string }, b: { is_system: boolean; key: string }): number {
  if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Permission keys not in the catalog — the check every role/scope write performs. */
export function unknownPermissions(keys: Iterable<string>): string[] {
  return [...new Set([...keys].filter((k) => !PERMISSION_KEYS.has(k)))].sort();
}
