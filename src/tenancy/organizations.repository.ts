import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  owner_user_id: string | null;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface OrganizationRead {
  id: string;
  slug: string;
  name: string;
  status: string;
  owner_user_id: string | null;
  settings: Record<string, unknown>;
  created_at: Date;
}

export function toOrganizationRead(row: OrganizationRow): OrganizationRead {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    owner_user_id: row.owner_user_id,
    settings: row.settings,
    created_at: row.created_at,
  };
}

const COLUMNS = "id, slug, name, status, owner_user_id, settings, created_at, updated_at, deleted_at";

@Injectable()
export class OrganizationsRepository {
  findById(tx: Tx, id: string): Promise<OrganizationRow | undefined> {
    return tx.one<OrganizationRow>(`SELECT ${COLUMNS} FROM organizations WHERE id = $1`, [id]);
  }

  findBySlug(tx: Tx, slug: string): Promise<OrganizationRow | undefined> {
    return tx.one<OrganizationRow>(`SELECT ${COLUMNS} FROM organizations WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
  }

  async slugExists(tx: Tx, slug: string): Promise<boolean> {
    return (await this.findBySlug(tx, slug)) !== undefined;
  }

  async insert(tx: Tx, org: { slug: string; name: string; ownerUserId: string }): Promise<OrganizationRow> {
    const row = await tx.one<OrganizationRow>(
      `INSERT INTO organizations (id, slug, name, status, owner_user_id, settings)
       VALUES ($1, $2, $3, 'active', $4, '{}'::jsonb) RETURNING ${COLUMNS}`,
      [newUuid(), org.slug, org.name, org.ownerUserId],
    );
    return row as OrganizationRow;
  }

  async update(tx: Tx, id: string, patch: { name?: string; settings?: Record<string, unknown> }): Promise<OrganizationRow> {
    const row = await tx.one<OrganizationRow>(
      `UPDATE organizations SET name = COALESCE($2, name), settings = COALESCE($3::jsonb, settings), updated_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, patch.name ?? null, patch.settings === undefined ? null : JSON.stringify(patch.settings)],
    );
    return row as OrganizationRow;
  }

  async setStatus(tx: Tx, id: string, status: "active" | "suspended" | "archived"): Promise<void> {
    await tx.query(`UPDATE organizations SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  }
}
