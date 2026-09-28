import { Injectable } from "@nestjs/common";
import { ClsService } from "nestjs-cls";

/**
 * Request-scoped actor and tenant context, backed by AsyncLocalStorage
 * (`nestjs-cls`). The single source of truth for "who is acting, in which
 * org": guards populate it, services and the database layer read it.
 */

export interface UserContext {
  readonly userId: string;
  readonly email: string;
  readonly isPlatformAdmin: boolean;
  /** Effective permission keys once a permission check bound them (`*` = platform admin). */
  readonly permissionKeys: ReadonlySet<string>;
  /** The `org` claim of the bearer JWT, if any — the last tenant-resolution fallback. */
  readonly orgClaim: string | null;
  /** Set when the actor is a programmatic key, not a user. */
  readonly apiKeyId: string | null;
  readonly apiKeyScopes: ReadonlySet<string> | null;
  readonly apiKeyCreatorId: string | null;
}

export interface TenantContext {
  readonly organizationId: string;
  readonly slug: string;
  /** Platform-admin / system scope: no tenant filtering. */
  readonly isPlatform: boolean;
}

const USER_KEY = "synapse.user";
const TENANT_KEY = "synapse.tenant";

@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService) {}

  requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.getId() : undefined;
  }

  user(): UserContext | undefined {
    return this.cls.isActive() ? this.cls.get<UserContext | undefined>(USER_KEY) : undefined;
  }

  setUser(user: UserContext): void {
    this.cls.set(USER_KEY, user);
  }

  requireUser(): UserContext {
    const user = this.user();
    if (!user) throw new Error("No user context is active for this operation");
    return user;
  }

  tenant(): TenantContext | undefined {
    return this.cls.isActive() ? this.cls.get<TenantContext | undefined>(TENANT_KEY) : undefined;
  }

  setTenant(tenant: TenantContext): void {
    this.cls.set(TENANT_KEY, tenant);
  }

  requireTenant(): TenantContext {
    const tenant = this.tenant();
    if (!tenant) throw new Error("No tenant context is active for this operation");
    return tenant;
  }
}
