import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { Database } from "../core/db/database";
import { RequestContext } from "../core/request-context";
import { TenantGuard } from "../tenancy/tenant.guard";
import type { AuditEntryRow } from "./audit.repository";
import { AuditRepository } from "./audit.repository";
import { AuditQuery } from "./audit.dto";

/** Cursor-shaped envelope for an append-only stream: `{data, next_cursor}`. */
export interface AuditPage {
  data: AuditEntryRow[];
  next_cursor: string | null;
}

/**
 * The organization's audit trail, newest first. Rows are org-scoped by
 * construction — a platform row (`organization_id IS NULL`) never surfaces
 * here — and the writer has already attributed API-key actions to the human
 * who created the key (`actor_type='api_key'`).
 */
@Controller("v1/audit")
@UseGuards(TenantGuard, PermissionsGuard)
@RequirePermission("audit:read")
export class AuditController {
  constructor(
    private readonly db: Database,
    private readonly context: RequestContext,
    private readonly audit: AuditRepository,
  ) {}

  @Get()
  async list(@Query() query: AuditQuery): Promise<AuditPage> {
    const organizationId = this.context.requireTenant().organizationId;
    const data = await this.db.transaction((tx) =>
      this.audit.listForOrg(tx, organizationId, {
        eventType: query.event_type ?? null,
        actorUserId: query.actor_user_id ?? null,
        limit: query.limit,
        offset: query.offset,
      }),
    );
    // The reference builds `AuditPage(data=…)` and leaves the cursor at its
    // default: offset paging is the contract, the field is the forward seam.
    return { data, next_cursor: null };
  }
}
