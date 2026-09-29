import { StorageError, TenantViolationError } from "../core/errors";

/**
 * Object keys are `{org_id}/{name}` — the org prefix IS the tenant boundary
 * for bytes, the way `organization_id` is for rows. A key from another org is
 * refused here, so no backend ever has to be trusted to scope a read.
 */
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,500}$/;

export function validateKey(key: string, organizationId?: string): void {
  if (!key || !KEY_PATTERN.test(key)) throw new StorageError("Invalid storage key");
  if (organizationId !== undefined && !key.startsWith(`${organizationId}/`)) {
    throw new TenantViolationError(`Storage key must be prefixed with the organization id (${organizationId}/)`);
  }
}

/** Build a validated org-scoped key from a caller-supplied object name. Nested paths allowed, traversal is not. */
export function scopedKey(organizationId: string, name: string): string {
  const safeName = name.replace(/^\/+/, "");
  if (safeName.includes("/") && safeName.split("/").includes("..")) throw new StorageError("Invalid storage key");
  const key = `${organizationId}/${safeName}`;
  validateKey(key, organizationId);
  return key;
}
