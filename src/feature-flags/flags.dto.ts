import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from "class-validator";

export const FLAG_KEY_PATTERN = /^[a-z0-9_.-]+$/;

export class FlagCreate {
  @IsString()
  @Length(2, 100)
  @Matches(FLAG_KEY_PATTERN)
  key!: string;

  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  rollout_percentage?: number | null;
}

export class FlagUpdate {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  rollout_percentage?: number;
}

/** The reference's `@model_validator`: an override with no scope is a 422, not a row that matches nothing. */
function RequiresScope(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: "requiresScope",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const body = args.object as OverrideCreate;
          return Boolean(body.organization_id ?? body.user_id);
        },
        defaultMessage(): string {
          return "override requires organization_id or user_id";
        },
      },
    });
  };
}

export class OverrideCreate {
  @IsOptional()
  @IsUUID()
  organization_id?: string | null;

  @IsOptional()
  @IsUUID()
  user_id?: string | null;

  @IsBoolean()
  @RequiresScope()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  note?: string | null;
}
