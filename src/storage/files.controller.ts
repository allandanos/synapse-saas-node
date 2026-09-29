import {
  type ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  type ExceptionFilter,
  Get,
  HttpCode,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { StorageError } from "../core/errors";
import { PageQuery, TOTAL_COUNT_HEADER } from "../core/pagination";
import { ProblemFilter } from "../core/problem.filter";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import { FeatureGuard, RequireFeature } from "../entitlements/feature.guard";
import { TenantGuard } from "../tenancy/tenant.guard";
import { PresignUploadRequest } from "./files.dto";
import type { FileRead } from "./files.repository";
import { DEFAULT_CONTENT_TYPE, FilesService, MAX_DIRECT_UPLOAD_BYTES, type PresignedUpload } from "./files.service";

/**
 * Multer is given a hard ceiling so a hostile client cannot buffer unbounded
 * bytes in memory, but the contract's limit is the 10 MiB rule in the service.
 * Anything multer rejects is rendered as the same `storage_error` 400 the
 * reference answers, so the two servers agree at every size.
 */
const MULTER_LIMIT_BYTES = MAX_DIRECT_UPLOAD_BYTES * 4;

@Catch(PayloadTooLargeException)
export class OversizedUploadFilter implements ExceptionFilter {
  constructor(private readonly problems: ProblemFilter) {}

  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    this.problems.catch(
      new StorageError(`Direct upload capped at ${String(MAX_DIRECT_UPLOAD_BYTES / (1024 * 1024))} MiB; use presigned upload`),
      host,
    );
  }
}

/**
 * File storage endpoints.
 *
 * Writing is feature-gated on `api_access` (storage ships on paid tiers) and
 * metered against the `storage_bytes` quota — the same enforcement path as
 * every other metered resource. Reading only needs `file:read`, so a plan
 * change never strands a tenant's existing files.
 */
@Controller("v1/files")
@UseGuards(TenantGuard, PermissionsGuard, FeatureGuard)
@UseFilters(OversizedUploadFilter)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly context: RequestContext,
  ) {}

  @Get()
  @RequirePermission("file:read")
  async list(@Query() page: PageQuery, @Res({ passthrough: true }) res: Response): Promise<FileRead[]> {
    const { items, total } = await this.files.list(this.context.requireTenant().organizationId, page);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items;
  }

  /** Direct upload (multipart, ≤10 MiB). Larger files use the presigned flow. */
  @Post()
  @HttpCode(201)
  @RequirePermission("file:write")
  @RequireFeature("api_access")
  // `AnyFilesInterceptor`, not `FileInterceptor("file")`: a single-field
  // interceptor rejects every other field name with multer's own error, while
  // the reference just reads `form.get("file")` and reports a missing part
  // itself. Accept the whole form and pick the part out here.
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: MULTER_LIMIT_BYTES } }))
  upload(@Req() request: Request, @UploadedFiles() parts?: Express.Multer.File[]): Promise<FileRead> {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.startsWith("multipart/form-data")) throw new StorageError("Expected multipart/form-data upload");
    const file = (parts ?? []).find((part) => part.fieldname === "file");
    if (!file) throw new StorageError("Missing 'file' part");
    return this.files.upload(this.context.requireTenant().organizationId, {
      filename: file.originalname || "unnamed",
      contentType: file.mimetype || DEFAULT_CONTENT_TYPE,
      data: file.buffer,
      userId: this.context.requireUser().userId,
    });
  }

  /**
   * Large-file path: reserve the quota, hand out a time-limited PUT URL, and
   * index the object as `pending`. The client uploads straight to the bucket,
   * then calls `POST /files/{id}/complete`. Local disk answers 409.
   */
  @Post("presign-upload")
  @HttpCode(200)
  @RequirePermission("file:write")
  @RequireFeature("api_access")
  presignUpload(@Body() body: PresignUploadRequest): Promise<PresignedUpload> {
    return this.files.presignUpload(
      this.context.requireTenant().organizationId,
      { name: body.name, contentType: body.content_type ?? DEFAULT_CONTENT_TYPE, sizeBytes: body.size_bytes },
      this.context.requireUser().userId,
    );
  }

  @Post(":fileId/complete")
  @HttpCode(200)
  @RequirePermission("file:write")
  complete(@Param("fileId", UuidPipe) fileId: string): Promise<FileRead> {
    return this.files.complete(this.context.requireTenant().organizationId, fileId);
  }

  @Get(":fileId")
  @RequirePermission("file:read")
  async download(@Param("fileId", UuidPipe) fileId: string, @Res() res: Response): Promise<void> {
    const file = await this.files.download(this.context.requireTenant().organizationId, fileId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.send(file.data);
  }

  @Post(":fileId/presign")
  @HttpCode(200)
  @RequirePermission("file:read")
  presignDownload(@Param("fileId", UuidPipe) fileId: string): Promise<{ url: string; key: string; expires_in: number }> {
    return this.files.presignDownload(this.context.requireTenant().organizationId, fileId);
  }

  /** Soft-delete the index row, remove the object, and give the bytes back to the quota. */
  @Delete(":fileId")
  @HttpCode(204)
  @RequirePermission("file:write")
  remove(@Param("fileId", UuidPipe) fileId: string): Promise<void> {
    return this.files.remove(this.context.requireTenant().organizationId, fileId);
  }
}
