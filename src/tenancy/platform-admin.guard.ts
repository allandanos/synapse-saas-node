import { type CanActivate, Injectable } from "@nestjs/common";
import { TenantNotResolvedError } from "../core/errors";
import { RequestContext } from "../core/request-context";

export const PLATFORM_SCOPE_ORG_ID = "00000000-0000-0000-0000-000000000000";

/** Operator surfaces (ADR 0008): platform admins only; everyone else gets 404, the surface is invisible. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly context: RequestContext) {}

  canActivate(): boolean {
    const user = this.context.requireUser();
    if (!user.isPlatformAdmin) throw new TenantNotResolvedError("Not found");
    // RLS: platform surfaces read across tenants for their transactions only.
    this.context.setTenant({ organizationId: PLATFORM_SCOPE_ORG_ID, slug: "platform", isPlatform: true });
    return true;
  }
}
