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

/**
 * The reference's `@model_validator`: an override carries **exactly one**
 * scope. Neither would match nothing; both used to be stored silently as a
 * user override with an `organization_id` column that said otherwise.
 */
function RequiresExactlyOneScope(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: "requiresExactlyOneScope",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const body = args.object as OverrideCreate;
          return (body.organization_id == null) !== (body.user_id == null);
        },
        defaultMessage(): string {
          return "override requires exactly one of organization_id or user_id";
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
  @RequiresExactlyOneScope()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  note?: string | null;
}
