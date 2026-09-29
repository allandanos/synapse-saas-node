import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";

/** A single PUT tops out at 5 GiB on S3; beyond that a client needs multipart upload. */
export const MAX_PRESIGNED_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export class PresignUploadRequest {
  @IsString()
  @Length(1, 255)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 128)
  content_type?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PRESIGNED_UPLOAD_BYTES)
  size_bytes!: number;
}
