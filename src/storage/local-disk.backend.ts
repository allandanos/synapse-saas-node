import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { NotFoundError, StorageError } from "../core/errors";
import type { StorageBackend } from "./backend";
import { validateKey } from "./keys";

/** Zero-config fallback: files under `SYNAPSE_STORAGE_ROOT/{org_id}/…`. */
export class LocalDiskStorage implements StorageBackend {
  readonly supportsPresignedUpload = false;

  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    validateKey(key);
    const path = resolve(this.root, key);
    // Traversal guard: `resolve` has already collapsed `..`, so a key that
    // escaped the root shows up here as a path outside it.
    if (path !== this.root && !path.startsWith(this.root + sep)) throw new StorageError("Invalid storage key");
    return path;
  }

  async put(key: string, data: Buffer, _contentType?: string): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const path = this.pathFor(key);
    try {
      return await readFile(path);
    } catch {
      throw new NotFoundError("Object not found");
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  presignGet(key: string): Promise<string> {
    this.pathFor(key); // validation still applies
    return Promise.reject(new StorageError("Presigned URLs require an S3-compatible backend"));
  }

  presignPut(key: string, _contentType?: string): Promise<string> {
    this.pathFor(key);
    return Promise.reject(new StorageError("Presigned URLs require an S3-compatible backend"));
  }

  async head(key: string): Promise<number | null> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }
}
