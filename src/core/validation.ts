import { type ArgumentMetadata, Injectable, type PipeTransform, ValidationPipe } from "@nestjs/common";
import type { ErrorRequestHandler } from "express";
import type { ValidationError } from "class-validator";
import { type ValidationIssue, ValidationFailedError } from "./errors";
import { isUuid } from "./ids";

/**
 * Request validation → `422 validation_failed` problem documents with the
 * per-field `errors[]` list (loc/msg/type), like the reference's parser.
 */

class PendingValidationFailure extends Error {
  constructor(readonly errors: ValidationError[]) {
    super("validation failed");
  }
}

const ROOT_BY_SOURCE: Record<string, string> = { body: "body", query: "query", param: "path", custom: "body" };

export function flattenValidationErrors(errors: ValidationError[], root: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const walk = (error: ValidationError, path: (string | number)[]): void => {
    const loc = [...path, error.property];
    for (const [type, msg] of Object.entries(error.constraints ?? {})) issues.push({ loc, msg, type });
    for (const child of error.children ?? []) walk(child, loc);
  };
  for (const error of errors) walk(error, [root]);
  return issues;
}

@Injectable()
export class ProblemValidationPipe extends ValidationPipe {
  constructor() {
    super({
      transform: true,
      whitelist: true,
      exceptionFactory: (errors) => new PendingValidationFailure(errors),
    });
  }

  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    try {
      return await super.transform(value, metadata);
    } catch (error) {
      if (error instanceof PendingValidationFailure) {
        throw new ValidationFailedError(flattenValidationErrors(error.errors, ROOT_BY_SOURCE[metadata.type] ?? "body"));
      }
      throw error;
    }
  }
}

/** Path parameters that must be UUIDs — malformed ones are 422, never 400 or 404. */
@Injectable()
export class UuidPipe implements PipeTransform<unknown, string> {
  transform(value: unknown, metadata: ArgumentMetadata): string {
    if (!isUuid(value)) {
      throw new ValidationFailedError([
        { loc: ["path", metadata.data ?? "id"], msg: "Input should be a valid UUID", type: "uuid_parsing" },
      ]);
    }
    return value;
  }
}

/** True for body-parser failures (malformed JSON, bad charset…), which Express tags `entity.parse.failed`. */
export function isBodyParseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { type?: unknown }).type === "entity.parse.failed";
}

/**
 * Express error middleware mounted right after the body parsers: Nest would
 * otherwise map the parser's SyntaxError to a bare 400 before any filter runs.
 */
export function bodyParseProblemMiddleware(): ErrorRequestHandler {
  return (error: unknown, _req, _res, next) => {
    next(isBodyParseError(error) ? new ValidationFailedError([{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }]) : error);
  };
}
