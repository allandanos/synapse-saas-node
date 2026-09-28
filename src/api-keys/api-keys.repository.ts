import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface ApiKeyRow {
  id: string;
  organization_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
}

export interface ApiKeyRead {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export function toApiKeyRead(row: ApiKeyRow): ApiKeyRead {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

export function isActiveKey(row: ApiKeyRow, now: Date = new Date()): boolean {
  if (row.revoked_at !== null) return false;
  return row.expires_at === null || now < row.expires_at;
}

const COLUMNS = "id, organization_id, name, prefix, key_hash, scopes, expires_at, last_used_at, revoked_at, created_by_user_id, created_at";

@Injectable()
export class ApiKeysRepository {
  async insert(
    tx: Tx,
    key: { organizationId: string; name: string; prefix: string; keyHash: string; scopes: string[]; expiresAt: Date | null; createdByUserId: string | null },
  ): Promise<ApiKeyRow> {
    const row = await tx.one<ApiKeyRow>(
      `INSERT INTO api_keys (id, organization_id, name, prefix, key_hash, scopes, expires_at, created_by_user_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, '{}'::jsonb) RETURNING ${COLUMNS}`,
      [newUuid(), key.organizationId, key.name, key.prefix, key.keyHash, key.scopes, key.expiresAt, key.createdByUserId],
    );
    return row as ApiKeyRow;
  }

  listForOrganization(tx: Tx, organizationId: string): Promise<ApiKeyRow[]> {
    return tx.rows<ApiKeyRow>(`SELECT ${COLUMNS} FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC, id`, [organizationId]);
  }

  findById(tx: Tx, keyId: string): Promise<ApiKeyRow | undefined> {
    return tx.one<ApiKeyRow>(`SELECT ${COLUMNS} FROM api_keys WHERE id = $1`, [keyId]);
  }

  findByHash(tx: Tx, keyHash: string): Promise<ApiKeyRow | undefined> {
    return tx.one<ApiKeyRow>(`SELECT ${COLUMNS} FROM api_keys WHERE key_hash = $1`, [keyHash]);
  }

  async revoke(tx: Tx, keyId: string): Promise<void> {
    await tx.query(`UPDATE api_keys SET revoked_at = now(), updated_at = now() WHERE id = $1`, [keyId]);
  }

  async touchLastUsed(tx: Tx, keyId: string): Promise<void> {
    await tx.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [keyId]);
  }
}
