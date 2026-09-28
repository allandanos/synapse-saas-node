import { IsArray, IsEmail, IsObject, IsOptional, IsString, Length, Matches } from "class-validator";

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export class OrganizationCreate {
  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(SLUG_PATTERN)
  slug?: string | null;
}

export class OrganizationUpdate {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string | null;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown> | null;
}

export class MemberInvite {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  role_keys?: string[];
}

export class MemberUpdate {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  role_keys?: string[] | null;

  @IsOptional()
  @IsString()
  @Matches(/^(active|suspended)$/)
  status?: string | null;
}
