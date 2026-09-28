import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsObject, IsOptional, IsString, Matches, Min, ValidateNested } from "class-validator";

export class UsageEventIn {
  @IsString()
  metric!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number = 1;

  @IsOptional()
  @IsString()
  idempotency_key?: string | null;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown> | null;
}

export class UsageBatchIn {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => UsageEventIn)
  events!: UsageEventIn[];
}

/** Set a gauge to `value`, or move it by `delta` — exactly one of the two (checked in the controller). */
export class GaugeIn {
  @IsString()
  metric!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number | null;

  @IsOptional()
  @IsInt()
  delta?: number | null;
}

export class UsageCheckQuery {
  @IsString()
  metric!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity?: number = 1;
}

export class UsageSummaryQuery {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  period?: string | null;
}
