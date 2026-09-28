import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PERMISSION_KEYS, unknownPermissions } from "../authorization/permissions";
import { AuditWriter } from "../core/audit";
import { Database } from "../core/db/database";
import { ApiKeyNotFoundError, PermissionDeniedError } from "../core/errors";
import { events } from "../core/events";
import { OutboxWriter } from "../core/outbox";
import { sha256Hex } from "../core/security";
import { type OrganizationRow, OrganizationsRepository } from "../tenancy/organizations.repository";
import { type ApiKeyRead, type ApiKeyRow, ApiKeysRepository, isActiveKey, toApiKeyRead } from "./api-keys.repository";

export const KEY_PREFIX = "sk_";
const KEY_RANDOM_BYTES = 32;
const PREFIX_DISPLAY_LENGTH = 8;
const DAY_MS = 86_400_000;

/**
 * Security model: `sk_<32 urlsafe bytes>` is generated once, SHA-256 hashed,
 * and only the hash is stored; the plaintext returns exactly once. A key can
 * never exceed its creator (ADR 0008): requested scopes must be a subset of
 * the creator's permissions, and an empty request snapshots them.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly db: Database,
    private readonly keys: ApiKeysRepository,
    private readonly orgs: OrganizationsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  createKey(input: {
    organizationId: string;
    name: string;
    scopes: string[];
    expiresInDays: number | null;
    createdByUserId: string | null;
    creatorKeys: ReadonlySet<string> | null;
  }): Promise<{ key: ApiKeyRead; plaintext: string }> {
    const unknown = unknownPermissions(input.scopes);
    if (unknown.length > 0) {
      throw new PermissionDeniedError(`Unknown permission scopes: ${JSON.stringify(unknown)}`, { unknown });
    }
    let scopes = [...input.scopes];
    if (input.creatorKeys !== null) {
      const creatorKeys = input.creatorKeys.has("*") ? PERMISSION_KEYS : input.creatorKeys;
      if (scopes.length === 0) scopes = [...creatorKeys].sort();
      const exceeding = [...new Set(scopes.filter((s) => !creatorKeys.has(s)))].sort();
      if (exceeding.length > 0) {
        throw new PermissionDeniedError(`Requested scopes exceed the creator's permissions: ${JSON.stringify(exceeding)}`, {
          exceeds_creator: exceeding,
        });
      }
    }
    const plaintext = KEY_PREFIX + randomBytes(KEY_RANDOM_BYTES).toString("base64url");
    return this.db.transaction(async (tx) => {
      const row = await this.keys.insert(tx, {
        organizationId: input.organizationId,
        name: input.name,
        prefix: plaintext.slice(0, PREFIX_DISPLAY_LENGTH),
        keyHash: sha256Hex(plaintext),
        scopes,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * DAY_MS) : null,
        createdByUserId: input.createdByUserId,
      });
      await this.audit.log(tx, {
        eventType: events.API_KEY_CREATED,
        organizationId: input.organizationId,
        targetType: "api_key",
        targetId: row.id,
        diff: { name: input.name, scopes },
      });
      await this.outbox.append(tx, {
        eventType: events.API_KEY_CREATED,
        aggregateType: "api_key",
        aggregateId: row.id,
        organizationId: input.organizationId,
        payload: { name: input.name, scopes },
      });
      return { key: toApiKeyRead(row), plaintext };
    });
  }

  listKeys(organizationId: string): Promise<ApiKeyRead[]> {
    return this.db.transaction(async (tx) => (await this.keys.listForOrganization(tx, organizationId)).map(toApiKeyRead));
  }

  revokeKey(keyId: string, organizationId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      const key = await this.keys.findById(tx, keyId);
      if (!key || key.organization_id !== organizationId) throw new ApiKeyNotFoundError("API key not found"); // 404 cross-tenant
      await this.keys.revoke(tx, keyId);
      await this.audit.log(tx, { eventType: events.API_KEY_REVOKED, organizationId, targetType: "api_key", targetId: keyId });
      await this.outbox.append(tx, {
        eventType: events.API_KEY_REVOKED,
        aggregateType: "api_key",
        aggregateId: keyId,
        organizationId,
        payload: { name: key.name },
      });
    });
  }

  /**
   * Resolve a plaintext key to its active row + active organization, or null.
   * Callers treat null as opaque 401 material — never reveal whether the key
   * existed, was revoked, expired, or its org is suspended.
   */
  authenticate(plaintext: string): Promise<{ key: ApiKeyRow; organization: OrganizationRow } | null> {
    if (!plaintext.startsWith(KEY_PREFIX)) return Promise.resolve(null);
    return this.db.transaction(async (tx) => {
      const key = await this.keys.findByHash(tx, sha256Hex(plaintext));
      if (!key || !isActiveKey(key)) return null;
      const organization = await this.orgs.findById(tx, key.organization_id);
      if (!organization || organization.deleted_at !== null || organization.status !== "active") return null;
      await this.keys.touchLastUsed(tx, key.id);
      return { key, organization };
    });
  }
}
