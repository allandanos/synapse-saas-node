import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import { MAX_PAGE_LIMIT } from "../core/pagination";

/** `GET /v1/audit` filters. Out-of-range limits/offsets are 422, like the reference's `Query(ge=…, le=…)`. */
export class AuditQuery {
  @IsOptional()
  @IsString()
  event_type?: string;

  @IsOptional()
  @IsUUID()
  actor_user_id?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = 50;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
