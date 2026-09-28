import { randomUUID } from "node:crypto";
import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ApiKeysService, KEY_PREFIX } from "../api-keys/api-keys.service";
import { Database } from "../core/db/database";
import { AuthenticationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { RequestContext } from "../core/request-context";
import { SecurityService } from "../core/security";
import { UsageService } from "../usage/usage.service";
import { IS_PUBLIC } from "./public.decorator";
import { UsersRepository } from "./users.repository";

/**
 * Bearer → principal. Two credential types share one code path:
 * - a JWT access token names a real user;
 * - an `sk_…` API key synthesises a principal bound to the key's organization
 *   (tenant pinned here, permissions = the key's scopes, bounded later by the
 *   creator's current permissions).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
    private readonly db: Database,
    private readonly security: SecurityService,
    private readonly users: UsersRepository,
    private readonly apiKeys: ApiKeysService,
    private readonly usage: UsageService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [execution.getHandler(), execution.getClass()])) return true;

    const request = execution.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) throw new AuthenticationError("Missing bearer token");
    const token = header.slice("Bearer ".length);

    if (token.startsWith(KEY_PREFIX)) {
      await this.authenticateApiKey(token);
      return true;
    }
    await this.authenticateJwt(token);
    return true;
  }

  private async authenticateApiKey(token: string): Promise<void> {
    const result = await this.apiKeys.authenticate(token);
    if (!result) throw new AuthenticationError("Invalid API key");
    const { key, organization } = result;
    const scopes = new Set(key.scopes);
    this.context.setTenant({ organizationId: key.organization_id, slug: organization.slug, isPlatform: false });
    this.context.setUser({
      userId: randomUUID(), // sentinel: matches no users row, never written to a FK
      email: `apikey:${key.prefix}`,
      isPlatformAdmin: false,
      permissionKeys: scopes,
      orgClaim: null,
      apiKeyId: key.id,
      apiKeyScopes: scopes,
      apiKeyCreatorId: key.created_by_user_id,
    });
    // Every key-authenticated call meters one api_requests unit (best effort,
    // never blocking): the tenant is bound above, so RLS admits the write.
    await this.usage.meterApiKeyRequest(key.organization_id);
  }

  private async authenticateJwt(token: string): Promise<void> {
    const claims = this.security.decodeAccessToken(token);
    if (!isUuid(claims.sub)) throw new AuthenticationError("Invalid token subject");
    const user = await this.db.transaction((tx) => this.users.findById(tx, claims.sub));
    if (!user || !user.is_active) throw new AuthenticationError("User not found or inactive");
    this.context.setUser({
      userId: user.id,
      email: user.email,
      isPlatformAdmin: user.is_platform_admin,
      permissionKeys: new Set(),
      orgClaim: claims.org ?? null,
      apiKeyId: null,
      apiKeyScopes: null,
      apiKeyCreatorId: null,
    });
  }
}
