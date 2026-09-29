import { resolve } from "node:path";
import { Logger, Module } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { ProblemFilter } from "../core/problem.filter";
import { AuthorizationModule } from "../authorization/authorization.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { UsageModule } from "../usage/usage.module";
import { STORAGE_BACKEND, type StorageBackend } from "./backend";
import { FilesController, OversizedUploadFilter } from "./files.controller";
import { FilesRepository } from "./files.repository";
import { FilesService } from "./files.service";
import { LocalDiskStorage } from "./local-disk.backend";
import { S3Storage } from "./s3.backend";

/** S3 when a bucket is configured; local disk otherwise (clone-and-run). */
export function buildStorageBackend(settings: Settings): StorageBackend {
  const logger = new Logger("Storage");
  if (settings.SYNAPSE_S3_BUCKET) {
    logger.log(`backend=s3 bucket=${settings.SYNAPSE_S3_BUCKET}${settings.SYNAPSE_S3_ENDPOINT_URL ? ` endpoint=${settings.SYNAPSE_S3_ENDPOINT_URL}` : ""}`);
    return new S3Storage({
      bucket: settings.SYNAPSE_S3_BUCKET,
      region: settings.SYNAPSE_S3_REGION,
      endpoint: settings.SYNAPSE_S3_ENDPOINT_URL,
      accessKeyId: settings.SYNAPSE_S3_ACCESS_KEY_ID,
      secretAccessKey: settings.SYNAPSE_S3_SECRET_ACCESS_KEY,
      presignSeconds: settings.SYNAPSE_STORAGE_PRESIGN_SECONDS,
    });
  }
  const root = resolve(settings.SYNAPSE_STORAGE_ROOT);
  logger.log(`backend=local root=${root}`);
  return new LocalDiskStorage(root);
}

/** `/v1/files` — metadata rows, the backend that holds the bytes, and the `storage_bytes` gauge. */
@Module({
  imports: [AuthorizationModule, TenancyModule, EntitlementsModule, UsageModule],
  controllers: [FilesController],
  providers: [
    FilesRepository,
    FilesService,
    ProblemFilter,
    OversizedUploadFilter,
    { provide: STORAGE_BACKEND, inject: [SETTINGS], useFactory: buildStorageBackend },
  ],
  exports: [FilesRepository, FilesService, STORAGE_BACKEND],
})
export class StorageModule {}
