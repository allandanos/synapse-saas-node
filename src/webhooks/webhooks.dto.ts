import { Type } from "class-transformer";
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, registerDecorator, type ValidationArguments, type ValidationOptions } from "class-validator";
import { MAX_PAGE_LIMIT } from "../core/pagination";

/**
 * The reference types the field as pydantic's `HttpUrl`, which demands an
 * absolute http(s) URL with a host. `class-validator`'s `@IsUrl` also accepts
 * bare hostnames, so parse it with WHATWG `URL` instead — same acceptance set,
 * and the normalised `href` is what gets stored (exactly what `str(HttpUrl)`
 * yields), so an endpoint row is byte-identical across implementations.
 */
function IsHttpUrl(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: "isHttpUrl",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return normaliseHttpUrl(value) !== null;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be an absolute http(s) URL`;
        },
      },
    });
  };
}

export function normaliseHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === "") return null;
    return url.href;
  } catch {
    return null;
  }
}

export class WebhookEndpointCreate {
  @IsHttpUrl()
  url!: string;

  /** Empty means every public event type. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string | null;
}

export class DeliveryQuery {
  @IsOptional()
  @IsUUID()
  endpoint_id?: string;

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
