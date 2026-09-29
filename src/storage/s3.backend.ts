import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NotFoundError, StorageError } from "../core/errors";
import type { StorageBackend } from "./backend";
import { validateKey } from "./keys";

export interface S3Options {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  presignSeconds: number;
}

function isMissing(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404 || /NoSuchKey|NotFound|Not Found/.test(text);
}

/** Any S3-compatible target: AWS S3, Cloudflare R2, MinIO. */
export class S3Storage implements StorageBackend {
  readonly supportsPresignedUpload = true;
  private readonly client: S3Client;

  constructor(private readonly options: S3Options) {
    if (!options.bucket) throw new StorageError("SYNAPSE_S3_BUCKET is not configured");
    this.client = new S3Client({
      region: options.region,
      // v3 otherwise attaches a CRC32 of the body to every request, which for
      // a presigned PUT is the checksum of an EMPTY body — the client's real
      // upload would then be rejected. Checksums stay on where S3 needs them.
      requestChecksumCalculation: "WHEN_REQUIRED",
      // A custom endpoint means MinIO/R2, which serve path-style buckets.
      ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
      ...(options.accessKeyId && options.secretAccessKey
        ? { credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } }
        : {}),
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<string> {
    validateKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: data, ContentType: contentType }));
    return key;
  }

  async get(key: string): Promise<Buffer> {
    validateKey(key);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      const bytes = await response.Body?.transformToByteArray();
      return Buffer.from(bytes ?? new Uint8Array());
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError("Object not found");
      throw new StorageError(`S3 get failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async delete(key: string): Promise<void> {
    validateKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  presignGet(key: string): Promise<string> {
    validateKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), { expiresIn: this.options.presignSeconds });
  }

  /**
   * `content-type` is explicitly signable so the URL commits the client to the
   * type it declared — boto3 signs it too, and `presign-upload` hands the
   * header back in the response for exactly that reason.
   */
  presignPut(key: string, contentType: string): Promise<string> {
    validateKey(key);
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.options.bucket, Key: key, ContentType: contentType }), {
      expiresIn: this.options.presignSeconds,
      signableHeaders: new Set(["content-type"]),
    });
  }

  async head(key: string): Promise<number | null> {
    validateKey(key);
    try {
      const meta = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return Number(meta.ContentLength ?? 0);
    } catch (error) {
      if (isMissing(error)) return null;
      throw new StorageError(`S3 head failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
