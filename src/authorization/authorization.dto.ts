import { IsArray, IsOptional, IsString, Length, Matches } from "class-validator";

export const ROLE_KEY_PATTERN = /^[a-z0-9_]+$/;

export class RoleCreate {
  @IsString()
  @Matches(ROLE_KEY_PATTERN)
  @Length(2, 64)
  key!: string;

  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}

export class RoleUpdate {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[] | null;
}
