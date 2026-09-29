import { Inject, Injectable } from "@nestjs/common";
import { AuditWriter } from "../core/audit";
import { SETTINGS, type Settings } from "../core/config";
import { Database, type Tx } from "../core/db/database";
import { NotFoundError, PresignUnsupportedError, StorageError, UploadIncompleteError } from "../core/errors";
import { events } from "../core/events";
import { OutboxWriter } from "../core/outbox";
import { UsageService } from "../usage/usage.service";
import { STORAGE_BACKEND, type StorageBackend } from "./backend";
import { type FileRead, FilesRepository, type StoredFileRow, toFileRead } from "./files.repository";
import { scopedKey } from "./keys";

/** Larger uploads go through the presigned flow; the reference caps the direct path at 10 MiB. */
export const MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 * 1024;

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface UploadInput {
  filename: string;
  contentType: string;
  data: Buffer;
  userId: string | null;
}

export interface PresignedUpload {
  id: string;
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expires_in: number;
}

export interface DownloadedFile {
  name: string;
  contentType: string;
  data: Buffer;
}

/**
 * File storage: metadata rows here, bytes in the backend, quota in the usage
 * gauge. `storage_bytes` is a LEVEL, not a flow, so the order of operations is
 * the contract: reserve capacity first (402 before a single byte is written),
 * then write, then index. Deleting walks it back the same way.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly db: Database,
    private readonly files: FilesRepository,
    private readonly usage: UsageService,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditWriter,
    @Inject(STORAGE_BACKEND) private readonly storage: StorageBackend,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  async list(organizationId: string, page: { limit: number; offset: number }): Promise<{ items: FileRead[]; total: number }> {
    const result = await this.db.transaction((tx) => this.files.page(tx, organizationId, page));
    return { items: result.rows.map(toFileRead), total: result.total };
  }

  async upload(organizationId: string, input: UploadInput): Promise<FileRead> {
    if (input.data.length > MAX_DIRECT_UPLOAD_BYTES) {
      throw new StorageError(`Direct upload capped at ${String(MAX_DIRECT_UPLOAD_BYTES / (1024 * 1024))} MiB; use presigned upload`);
    }
    const key = scopedKey(organizationId, input.filename);

    // Capacity first: a 402 here must leave the backend untouched.
    await this.db.transaction((tx) => this.usage.adjustGauge(tx, organizationId, "storage_bytes", input.data.length));
    try {
      await this.storage.put(key, input.data, input.contentType);
      const row = await this.db.transaction(async (tx) => {
        const inserted = await this.files.insert(tx, {
          organizationId,
          key,
          name: input.filename,
          contentType: input.contentType,
          sizeBytes: input.data.length,
          status: "ready",
          createdByUserId: input.userId,
        });
        await this.recordFileEvent(tx, events.FILE_UPLOADED, inserted);
        return inserted;
      });
      return toFileRead(row);
    } catch (error) {
      // The reservation is committed; a failed write would otherwise leak it.
      await this.releaseQuota(organizationId, input.data.length);
      throw error;
    }
  }

  async presignUpload(
    organizationId: string,
    input: { name: string; contentType: string; sizeBytes: number },
    userId: string | null,
  ): Promise<PresignedUpload> {
    this.requirePresignSupport({ direct_upload_limit_bytes: MAX_DIRECT_UPLOAD_BYTES });
    // Reserve now (402 on breach); released by complete-mismatch, delete, or retention.
    await this.db.transaction((tx) => this.usage.adjustGauge(tx, organizationId, "storage_bytes", input.sizeBytes));
    const key = scopedKey(organizationId, input.name);
    const url = await this.storage.presignPut(key, input.contentType);
    const row = await this.db.transaction((tx) =>
      this.files.insert(tx, {
        organizationId,
        key,
        name: input.name,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        status: "pending",
        createdByUserId: userId,
      }),
    );
    return {
      id: row.id,
      key,
      url,
      method: "PUT",
      headers: { "Content-Type": input.contentType },
      expires_in: this.settings.SYNAPSE_STORAGE_PRESIGN_SECONDS,
    };
  }

  /**
   * Verify a presigned upload landed and matches its reservation. A mismatch
   * releases the reservation and soft-deletes the row in a transaction that
   * COMMITS before the 409 is raised — the release must not roll back with
   * the error, or the tenant would be billed for bytes that never arrived.
   */
  async complete(organizationId: string, fileId: string): Promise<FileRead> {
    const row = await this.db.transaction((tx) => this.requireScoped(tx, fileId, organizationId, ["pending", "ready"]));
    if (row.status === "ready") return toFileRead(row); // idempotent

    const expected = Number(row.size_bytes);
    const actual = await this.storage.head(row.key);
    if (actual === null || actual !== expected) {
      await this.db.transaction(async (tx) => {
        await this.usage.adjustGauge(tx, organizationId, "storage_bytes", -expected);
        await this.files.softDelete(tx, row.id);
      });
      throw new UploadIncompleteError("Object missing or size mismatch; request a new presigned upload", {
        expected_bytes: expected,
        actual_bytes: actual,
      });
    }
    return toFileRead(
      await this.db.transaction(async (tx) => {
        const ready = await this.files.markReady(tx, row.id);
        await this.recordFileEvent(tx, events.FILE_UPLOADED, ready);
        return ready;
      }),
    );
  }

  async download(organizationId: string, fileId: string): Promise<DownloadedFile> {
    const row = await this.db.transaction((tx) => this.requireScoped(tx, fileId, organizationId));
    return { name: row.name, contentType: row.content_type, data: await this.storage.get(row.key) };
  }

  async presignDownload(organizationId: string, fileId: string): Promise<{ url: string; key: string; expires_in: number }> {
    // The backend check comes before the row lookup, like the reference: the
    // answer does not depend on whether this particular file exists.
    this.requirePresignSupport();
    const row = await this.db.transaction((tx) => this.requireScoped(tx, fileId, organizationId));
    return { url: await this.storage.presignGet(row.key), key: row.key, expires_in: this.settings.SYNAPSE_STORAGE_PRESIGN_SECONDS };
  }

  async remove(organizationId: string, fileId: string): Promise<void> {
    const row = await this.db.transaction(async (tx) => {
      const found = await this.requireScoped(tx, fileId, organizationId, ["pending", "ready"]);
      await this.files.softDelete(tx, found.id);
      await this.usage.adjustGauge(tx, organizationId, "storage_bytes", -Number(found.size_bytes));
      await this.recordFileEvent(tx, events.FILE_DELETED, found);
      return found;
    });
    await this.storage.delete(row.key);
  }

  /**
   * `file.uploaded` / `file.deleted` are in the public event catalog, so they
   * fan out to tenant webhooks AND leave an audit row — both written in the
   * same transaction as the index change, so a tenant can never see an event
   * for a file the database does not have (or miss one it does).
   */
  private async recordFileEvent(tx: Tx, eventType: string, row: StoredFileRow): Promise<void> {
    const payload = {
      file_id: row.id,
      name: row.name,
      content_type: row.content_type,
      size_bytes: Number(row.size_bytes),
    };
    await this.outbox.append(tx, {
      eventType,
      aggregateType: "file",
      aggregateId: row.id,
      organizationId: row.organization_id,
      payload,
    });
    await this.audit.log(tx, {
      eventType,
      organizationId: row.organization_id,
      targetType: "file",
      targetId: row.id,
      diff: payload,
    });
  }

  private requirePresignSupport(extras?: Record<string, unknown>): void {
    if (this.storage.supportsPresignedUpload) return;
    throw new PresignUnsupportedError(
      extras
        ? "Presigned uploads need an S3-compatible backend; use multipart POST /files"
        : "Presigned URLs need an S3-compatible backend; download via GET /files/{id}",
      extras,
    );
  }

  private async releaseQuota(organizationId: string, bytes: number): Promise<void> {
    await this.db.transaction((tx) => this.usage.adjustGauge(tx, organizationId, "storage_bytes", -bytes, false));
  }

  private async requireScoped(
    tx: Tx,
    fileId: string,
    organizationId: string,
    statuses: ("pending" | "ready")[] = ["ready"],
  ): Promise<StoredFileRow> {
    const row = await this.files.findScoped(tx, fileId, organizationId, statuses);
    if (!row) throw new NotFoundError("File not found"); // cross-tenant ⇒ the same 404
    return row;
  }
}
