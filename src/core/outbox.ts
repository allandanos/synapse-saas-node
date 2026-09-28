import { Injectable } from "@nestjs/common";
import type { Tx } from "./db/database";
import { audienceFor } from "./events";
import { uuidV7 } from "./ids";

export interface OutboxEntry {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  organizationId?: string | null;
}

/**
 * Transactional outbox writer: called INSIDE the mutating transaction so the
 * event commits atomically with the state change. Internal events (tokens,
 * reset links) are stamped `audience='internal'` and never fan out.
 */
@Injectable()
export class OutboxWriter {
  async append(tx: Tx, entry: OutboxEntry): Promise<string> {
    const id = uuidV7();
    await tx.query(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, organization_id, event_type, payload, audience, attempts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 0)`,
      [id, entry.aggregateType, entry.aggregateId, entry.organizationId ?? null, entry.eventType, JSON.stringify(entry.payload), audienceFor(entry.eventType)],
    );
    return id;
  }
}
