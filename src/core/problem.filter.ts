import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger, NotFoundException } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  BASE_PROBLEM_URI,
  ConflictError,
  DomainError,
  HttpError,
  MethodNotAllowedError,
  NotFoundError,
  type ProblemDocument,
  ValidationFailedError,
} from "./errors";
import { RequestContext } from "./request-context";
import { RouteTable } from "./route-table";
import { isBodyParseError } from "./validation";

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

  constructor(
    private readonly context: RequestContext,
    private readonly routes: RouteTable,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = this.context.requestId() ?? headerValue(request.headers["x-request-id"]);
    const instance = (request.originalUrl ?? request.url ?? "").split("?")[0];
    const problem = this.toProblem(exception, instance, requestId, request.method);
    if (requestId) response.setHeader("X-Request-Id", requestId);
    if (problem.status === 405) response.setHeader("Allow", [...this.routes.methodsFor(instance)].filter((m) => m !== "ALL").join(", "));
    response.status(problem.status).json(problem);
  }

  private toProblem(exception: unknown, instance: string, requestId: string | undefined, method: string): ProblemDocument {
    if (exception instanceof DomainError) return exception.toProblem({ instance, requestId });
    if (isBodyParseError(exception)) {
      return new ValidationFailedError([{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }]).toProblem({ instance, requestId });
    }
    if (isUniqueViolation(exception)) {
      return new ConflictError("A row with the same unique key already exists").toProblem({ instance, requestId });
    }
    if (exception instanceof NotFoundException) {
      // Express answers a known path with the wrong method as a 404; the contract says 405.
      const allowed = this.routes.methodsFor(instance);
      const wrongMethod = allowed.size > 0 && !allowed.has("ALL") && !allowed.has(method.toUpperCase());
      const error = wrongMethod ? new MethodNotAllowedError("Method not allowed") : new NotFoundError("Not found");
      return error.toProblem({ instance, requestId });
    }
    if (exception instanceof HttpException) {
      return new HttpError(exception.getStatus(), exception.message).toProblem({ instance, requestId });
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
