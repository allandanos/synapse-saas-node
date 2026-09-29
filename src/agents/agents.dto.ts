import { IsObject, IsOptional, IsString, Length, Matches } from "class-validator";

export const AGENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class AgentCreate {
  @IsString()
  @Length(2, 100)
  @Matches(AGENT_SLUG_PATTERN)
  slug!: string;

  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class AgentUpdate {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
