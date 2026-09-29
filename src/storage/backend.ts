/**
 * One interface, two backends: local disk (clone-and-run, no presigned URLs)
 * and anything S3-compatible (AWS S3, Cloudflare R2, MinIO). The routes never
 * branch on which is configured except where the contract does — the two
 * `presign_unsupported` 409s.
 */
export interface StorageBackend {
  put(key: string, data: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Time-limited download URL — the preferred way to serve large objects. */
  presignGet(key: string): Promise<string>;
  /** Time-limited upload URL — large files bypass the API entirely. */
  presignPut(key: string, contentType: string): Promise<string>;
  /** Size of the stored object, or `null` when it does not exist (yet). */
  head(key: string): Promise<number | null>;
  readonly supportsPresignedUpload: boolean;
}

export const STORAGE_BACKEND = Symbol("STORAGE_BACKEND");
