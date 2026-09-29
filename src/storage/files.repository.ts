import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";

export type StoredFileStatus = "pending" | "ready";

export interface StoredFileRow {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  content_type: string;
  size_bytes: string | number;
  status: StoredFileStatus;
  deleted_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
}

/** The wire shape (`FileRead`). `size_bytes` is a bigint column, so it arrives as a string. */
export interface FileRead {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  content_type: string;
  size_bytes: number;
  status: string;
  created_at: Date;
}

export function toFileRead(row: StoredFileRow): FileRead {
  return {
    id: row.id,
    organization_id: row.organization_id,
    key: row.key,
    name: row.name,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    status: row.status,
    created_at: row.created_at,
  };
}

const COLUMNS = "id, organization_id, key, name, content_type, size_bytes, status, deleted_at, created_by_user_id, created_at";

@Injectable()
export class FilesRepository {
  /** Ready rows only, newest first, counted and sliced in the database. */
  async page(tx: Tx, organizationId: string, page: { limit: number; offset: number }): Promise<{ rows: StoredFileRow[]; total: number }> {
    const counted = await tx.one<{ total: string }>(
      `SELECT count(*)::text AS total FROM stored_files WHERE organization_id = $1 AND deleted_at IS NULL AND status = 'ready'`,
      [organizationId],
    );
    const rows = await tx.rows<StoredFileRow>(
      `SELECT ${COLUMNS} FROM stored_files WHERE organization_id = $1 AND deleted_at IS NULL AND status = 'ready'
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [organizationId, page.limit, page.offset],
    );
    return { rows, total: Number(counted?.total ?? 0) };
  }

  /** Cross-tenant, deleted and wrong-status rows are all the same 404. */
  findScoped(tx: Tx, id: string, organizationId: string, statuses: StoredFileStatus[] = ["ready"]): Promise<StoredFileRow | undefined> {
    return tx.one<StoredFileRow>(
      `SELECT ${COLUMNS} FROM stored_files WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND status = ANY($3::text[])`,
      [id, organizationId, statuses],
    );
  }

  async insert(
    tx: Tx,
    file: {
      organizationId: string;
      key: string;
      name: string;
      contentType: string;
      sizeBytes: number;
      status: StoredFileStatus;
      createdByUserId: string | null;
    },
  ): Promise<StoredFileRow> {
    const row = await tx.one<StoredFileRow>(
      `INSERT INTO stored_files (id, organization_id, key, name, content_type, size_bytes, status, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [newUuid(), file.organizationId, file.key, file.name, file.contentType, file.sizeBytes, file.status, file.createdByUserId],
    );
    return row as StoredFileRow;
  }

  async markReady(tx: Tx, id: string): Promise<StoredFileRow> {
    const row = await tx.one<StoredFileRow>(`UPDATE stored_files SET status = 'ready', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [id]);
    return row as StoredFileRow;
  }

  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.query(`UPDATE stored_files SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
  }

  /**
   * Presigned uploads that were never completed: soft-delete them and report
   * the bytes each one had reserved so the gauge can be given back.
   */
  releaseStalePending(tx: Tx, ttlSeconds: number): Promise<{ organization_id: string; size_bytes: string }[]> {
    return tx.rows<{ organization_id: string; size_bytes: string }>(
      `UPDATE stored_files SET deleted_at = now(), updated_at = now()
        WHERE status = 'pending' AND deleted_at IS NULL AND created_at < now() - make_interval(secs => $1)
        RETURNING organization_id, size_bytes::text AS size_bytes`,
      [ttlSeconds],
    );
  }
}
