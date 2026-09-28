import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { ConflictError, DomainError, type ProblemDocument, ValidationFailedError, BASE_PROBLEM_URI } from "./errors";
import { RequestContext } from "./request-context";
import { isBodyParseError } from "./validation";

const TITLE_BY_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
};

const PG_UNIQUE_VIOLATION = "23505";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION;
}

/**
 * Every error leaves the API as an RFC 7807 problem document — domain errors,
 * Nest's own HTTP exceptions (404, 405, …), request-parsing failures (422)
 * and unexpected failures (500). `X-Request-Id` rides on every response.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  constructor(private readonly context: RequestContext) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = this.context.requestId() ?? headerValue(request.headers["x-request-id"]);
    const instance = (request.originalUrl ?? request.url ?? "").split("?")[0];
    const problem = this.toProblem(exception, instance, requestId);
    if (requestId) response.setHeader("X-Request-Id", requestId);
    response.status(problem.status).json(problem);
  }

  private toProblem(exception: unknown, instance: string, requestId: string | undefined): ProblemDocument {
    if (exception instanceof DomainError) return exception.toProblem({ instance, requestId });
    if (isBodyParseError(exception)) {
      return new ValidationFailedError([{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }]).toProblem({ instance, requestId });
    }
    if (isUniqueViolation(exception)) {
      return new ConflictError("A row with the same unique key already exists").toProblem({ instance, requestId });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const title = TITLE_BY_STATUS[status] ?? "http_error";
      const doc: ProblemDocument = {
        type: `${BASE_PROBLEM_URI}/${title}`,
        title: title.replace(/_/g, " "),
        status,
        detail: status === 404 ? "Not Found" : exception.message,
        instance,
      };
      if (requestId) doc.request_id = requestId;
      return doc;
    }
    this.logger.error(`unhandled exception on ${instance}`, exception instanceof Error ? exception.stack : String(exception));
    const doc: ProblemDocument = {
      type: `${BASE_PROBLEM_URI}/internal_error`,
      title: "internal error",
      status: 500,
      detail: "An unexpected error occurred.",
      instance,
    };
    if (requestId) doc.request_id = requestId;
    return doc;
  }
}
