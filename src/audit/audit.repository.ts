import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";

export interface AuditEntryRow {
  id: string;
  organization_id: string | null;
  actor_user_id: string | null;
  actor_type: string;
  event_type: string;
  target_type: string | null;
  target_id: string | null;
  diff: Record<string, unknown> | null;
  request_id: string | null;
  created_at: Date;
}

export interface AuditQueryFilters {
  eventType?: string | null;
  actorUserId?: string | null;
  limit: number;
  offset: number;
}

const COLUMNS = "id, organization_id, actor_user_id, actor_type, event_type, target_type, target_id, diff, request_id, created_at";

/** Reads the rows `AuditWriter` has been writing since milestone 2. Append-only: no update/delete here. */
@Injectable()
export class AuditRepository {
  listForOrg(tx: Tx, organizationId: string, filters: AuditQueryFilters): Promise<AuditEntryRow[]> {
    const where = ["organization_id = $1"];
    const params: unknown[] = [organizationId];
    if (filters.eventType) {
      params.push(filters.eventType);
      where.push(`event_type = $${String(params.length)}`);
    }
    if (filters.actorUserId) {
      params.push(filters.actorUserId);
      where.push(`actor_user_id = $${String(params.length)}`);
    }
    params.push(filters.limit, filters.offset);
    return tx.rows<AuditEntryRow>(
      `SELECT ${COLUMNS} FROM audit_logs WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${String(params.length - 1)} OFFSET $${String(params.length)}`,
      params,
    );
  }
}
