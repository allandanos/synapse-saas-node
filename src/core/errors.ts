/**
 * Domain error hierarchy and RFC 7807 mapping — `contracts/problems.json`.
 *
 * Every service-raised error derives from `DomainError` and carries the HTTP
 * status, the stable problem title, and typed extras merged into the problem
 * document. Transport code never invents error semantics.
 */

export const BASE_PROBLEM_URI = "https://synapse-saas.dev/problems";

export type ProblemExtras = Record<string, unknown>;

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  request_id?: string;
  [extension: string]: unknown;
}

export class DomainError extends Error {
  readonly status: number = 400;
  readonly title: string = "domain_error";
  readonly extras: ProblemExtras;

  constructor(message?: string, extras?: ProblemExtras) {
    super(message ?? "");
    this.name = new.target.name;
    this.extras = { ...(extras ?? {}) };
    if (!message) this.message = this.title;
  }

  get problemType(): string {
    return `${BASE_PROBLEM_URI}/${this.title}`;
  }

  toProblem(options: { instance?: string; requestId?: string } = {}): ProblemDocument {
    // Extras first: the RFC 7807 members and request_id always win, so an
    // extension named `status` can never rewrite the HTTP status in the body.
    const doc: Record<string, unknown> = { ...this.extras };
    doc.type = this.problemType;
    doc.title = this.title.replace(/_/g, " ");
    doc.status = this.status;
    doc.detail = this.message || this.title;
    if (options.instance !== undefined) doc.instance = options.instance;
    if (options.requestId !== undefined) doc.request_id = options.requestId;
    return doc as ProblemDocument;
  }
}

function define(status: number, title: string): typeof DomainError {
  return class extends DomainError {
    override readonly status = status;
    override readonly title = title;
    constructor(message?: string, extras?: ProblemExtras) {
      super(message ?? title, extras);
    }
  };
}

// ── Core / context ─────────────────────────────────────────────────────────────
export const TenantContextMissingError = define(400, "tenant_context_missing");
export const TenantViolationError = define(403, "tenant_violation");
/** Org could not be resolved OR the user is not a member. Deliberately 404 — never leak existence. */
export const TenantNotResolvedError = define(404, "not_found");

// ── Identity ───────────────────────────────────────────────────────────────────
export const AuthenticationError = define(401, "unauthorized");
export const InvalidCredentialsError = define(401, "invalid_credentials");
/** A rotated refresh token was replayed — possible theft. Chain is revoked. */
export const TokenReuseError = define(401, "token_reuse_detected");
export const EmailAlreadyRegisteredError = define(409, "email_already_registered");
export const WeakPasswordError = define(400, "weak_password");
export const UserNotFoundError = define(404, "user_not_found");

// ── Tenancy ────────────────────────────────────────────────────────────────────
export const OrganizationNotFoundError = define(404, "not_found");
export const SlugUnavailableError = define(409, "slug_unavailable");
/** Operator-suspended org: members are told why (403), never a bare 404. */
export const OrganizationSuspendedError = define(403, "organization_suspended");
export const MembershipLimitReachedError = define(402, "usage_limit_exceeded");
export const NotAMemberError = define(404, "not_found");
export const InviteNotFoundError = define(404, "invite_not_found");
export const InviteAlreadyUsedError = define(409, "invite_already_used");

// ── Authorization ──────────────────────────────────────────────────────────────
export const PermissionDeniedError = define(403, "permission_denied");
export const RoleNotFoundError = define(404, "role_not_found");
export const SystemRoleImmutableError = define(409, "system_role_immutable");

// ── API keys ──────────────────────────────────────────────────────────────────
export const ApiKeyNotFoundError = define(404, "api_key_not_found");

// ── Misc ───────────────────────────────────────────────────────────────────────
export const NotFoundError = define(404, "not_found");
export const MethodNotAllowedError = define(405, "method_not_allowed");
export const ConflictError = define(409, "conflict");
export const RateLimitedError = define(429, "rate_limited");

/** Any other framework-raised HTTP error (413, 415, …): `http_error` with the real status. */
export class HttpError extends DomainError {
  override readonly status: number;
  override readonly title = "http_error";

  constructor(status: number, message?: string) {
    super(message ?? "Request rejected");
    this.status = status;
  }
}

export interface ValidationIssue {
  loc: (string | number)[];
  msg: string;
  type: string;
}

/** Request-parsing failures: `422 validation_failed` with the per-field list in `errors`. */
export class ValidationFailedError extends DomainError {
  override readonly status = 422;
  override readonly title = "validation_failed";

  constructor(issues: ValidationIssue[]) {
    const fields = issues
      .slice(0, 3)
      .map((issue) => issue.loc.slice(1).map(String).join(".") || "body")
      .join(", ");
    super(`Invalid request: ${fields}`, { errors: issues });
  }
}
