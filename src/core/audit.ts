import { Injectable } from "@nestjs/common";
import type { Tx } from "./db/database";
import { uuidV7 } from "./ids";
import { RequestContext } from "./request-context";

export interface AuditEntry {
  eventType: string;
  organizationId?: string | null;
  actorUserId?: string | null;
  actorType?: "user" | "api_key" | "system";
  targetType?: string | null;
  targetId?: string | null;
  diff?: Record<string, unknown> | null;
}

/**
 * One call, one immutable row, same transaction as the change. An API-key
 * principal is attributed to the human who created the key with
 * `actor_type='api_key'`; its sentinel user id never reaches the FK column.
 */
@Injectable()
export class AuditWriter {
  constructor(private readonly context: RequestContext) {}

  async log(tx: Tx, entry: AuditEntry): Promise<void> {
    const user = this.context.user();
    let actor = entry.actorUserId ?? null;
    let actorType: string = entry.actorType ?? "user";
    let diff = entry.diff ?? null;
    if (actor === null && user) {
      if (user.apiKeyId !== null) {
        actor = user.apiKeyCreatorId;
        actorType = "api_key";
        diff = { ...(diff ?? {}), api_key_id: user.apiKeyId };
      } else {
        actor = user.userId;
      }
    }
    if (actor === null && actorType === "user") actorType = "system";
    await tx.query(
      `INSERT INTO audit_logs (id, organization_id, actor_user_id, actor_type, event_type, target_type, target_id, diff, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        uuidV7(),
        entry.organizationId ?? null,
        actor,
        actorType,
        entry.eventType,
        entry.targetType ?? null,
        entry.targetId ?? null,
        diff === null ? null : JSON.stringify(diff),
        this.context.requestId() ?? null,
      ],
    );
  }
}
