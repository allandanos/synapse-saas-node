import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { Database } from "../core/db/database";
import { OrganizationSuspendedError, TenantNotResolvedError } from "../core/errors";
import { isUuid } from "../core/ids";
import { RequestContext, type UserContext } from "../core/request-context";
import { MembershipsRepository } from "./memberships.repository";
import { OrganizationsRepository } from "./organizations.repository";

type OrgReference = { kind: "id"; value: string } | { kind: "slug"; value: string };

const NON_TENANT_SUBDOMAINS = new Set(["www", "api", "app"]);
// An IP literal has no subdomain to read a tenant from (the reference would try "127" as a slug).
const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[/;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Tenant resolution: `X-Org-Id` → `X-Org-Slug` → subdomain → JWT `org` claim,
 * then a membership check. Failure is 404 — never 403 — so the API doesn't
 * leak which organizations exist. Suspension is checked AFTER membership so a
 * non-member learns nothing; platform admins keep read access to investigate.
 * When RLS is on, the tenant GUC is bound before the membership query.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly context: RequestContext,
    private readonly db: Database,
    private readonly orgs: OrganizationsRepository,
    private readonly members: MembershipsRepository,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    // API-key auth pins the tenant during authentication; membership checks
    // don't apply (the key IS its org's credential).
    const existing = this.context.tenant();
    if (existing && !existing.isPlatform) return true;

    const request = execution.switchToHttp().getRequest<Request>();
    const user = this.context.requireUser();
    const reference = resolveOrgReference(request, user);
    if (reference === null) throw new TenantNotResolvedError("No organization context for this request");

    await this.db.transaction(async (tx) => {
      const org = reference.kind === "id" ? await this.orgs.findById(tx, reference.value) : await this.orgs.findBySlug(tx, reference.value);
      if (!org || org.deleted_at !== null) throw new TenantNotResolvedError("Organization not found");

      // RLS: bind the tenant BEFORE the membership query — under policies that
      // query would otherwise be empty for every non-owner role.
      await tx.bindTenant(org.id);
      const membership = await this.members.getActive(tx, org.id, user.userId);
      if (!membership && !user.isPlatformAdmin) throw new TenantNotResolvedError("Organization not found");

      if (org.status !== "active" && !user.isPlatformAdmin) {
        throw new OrganizationSuspendedError("Organization is suspended", { organization_id: org.id, organization_status: org.status });
      }
      this.context.setTenant({ organizationId: org.id, slug: org.slug, isPlatform: false });
    });
    return true;
  }
}

export function resolveOrgReference(request: Request, user: UserContext): OrgReference | null {
  const orgId = headerValue(request.headers["x-org-id"]);
  if (orgId) {
    if (!isUuid(orgId)) throw new TenantNotResolvedError("Invalid X-Org-Id header");
    return { kind: "id", value: orgId };
  }
  const orgSlug = headerValue(request.headers["x-org-slug"]);
  if (orgSlug) return { kind: "slug", value: orgSlug };

  // Subdomain: acme.localhost / acme.app.example.com (skip www, api, app)
  const host = (headerValue(request.headers.host) ?? "").split(":")[0]?.toLowerCase() ?? "";
  const firstLabel = host.split(".")[0] ?? "";
  if (host.includes(".") && !IP_LITERAL_RE.test(host) && !NON_TENANT_SUBDOMAINS.has(firstLabel)) {
    return { kind: "slug", value: firstLabel };
  }

  // JWT org claim (set at token mint when an org is active)
  if (user.orgClaim && isUuid(user.orgClaim)) return { kind: "id", value: user.orgClaim };
  return null;
}
