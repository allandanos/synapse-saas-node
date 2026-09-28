import { IsArray, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";

export class ApiKeyCreate {
  @IsString()
  @Length(1, 200)
  name!: string;

  /** Empty ⇒ a snapshot of everything the creator can exercise right now. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expires_in_days?: number | null;
}
