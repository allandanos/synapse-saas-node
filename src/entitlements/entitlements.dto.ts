import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min, MinLength } from "class-validator";

export class GrantRequest {
  @IsString()
  @MinLength(1)
  feature_key!: string;

  @IsString()
  @Matches(/^(trial|addon|promo|beta|override|enterprise|grandfather)$/)
  source!: string;

  /** False ⇒ kill switch: a high-priority grant that REMOVES the feature. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean = true;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  duration_days?: number | null;

  @IsOptional()
  @IsString()
  note?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  limit_value?: number | null;
}
