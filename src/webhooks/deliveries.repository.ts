import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";
import { MAX_DELIVERY_ATTEMPTS } from "./envelope";

export interface WebhookEndpointRow {
  id: string;
  organization_id: string;
  url: string;
  secret_encrypted: Buffer;
  description: string | null;
  events: string[];
  is_active: boolean;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  organization_id: string;
  outbox_event_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed" | "exhausted";
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  last_response_code: number | null;
  last_error: string | null;
  response_excerpt: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export interface DeliveryPatch {
  status?: WebhookDeliveryRow["status"];
  attempts?: number;
  next_attempt_at?: Date;
  last_response_code?: number | null;
  last_error?: string | null;
  response_excerpt?: string | null;
  delivered_at?: Date | null;
}

const ENDPOINT_COLUMNS = "id, organization_id, url, secret_encrypted, description, events, is_active";
const DELIVERY_COLUMNS =
  "id, endpoint_id, organization_id, outbox_event_id, event_type, payload, status, attempts, max_attempts, next_attempt_at, last_response_code, last_error, response_excerpt, delivered_at, created_at";

@Injectable()
export class WebhookDeliveriesRepository {
  /** Active endpoints of an org subscribed to `eventType` (an empty filter means all). */
  activeEndpointsFor(tx: Tx, organizationId: string, eventType: string): Promise<WebhookEndpointRow[]> {
    return tx.rows<WebhookEndpointRow>(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints
       WHERE organization_id = $1 AND is_active = true AND (events = '{}' OR $2 = ANY(events))
       ORDER BY created_at`,
      [organizationId, eventType],
    );
  }

  findEndpoint(tx: Tx, id: string): Promise<WebhookEndpointRow | undefined> {
    return tx.one<WebhookEndpointRow>(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = $1`, [id]);
  }

  async enqueue(
    tx: Tx,
    delivery: { endpointId: string; organizationId: string; outboxEventId: string | null; eventType: string; payload: Record<string, unknown> },
  ): Promise<WebhookDeliveryRow> {
    const row = await tx.one<WebhookDeliveryRow>(
      `INSERT INTO webhook_deliveries (id, endpoint_id, organization_id, outbox_event_id, event_type, payload, status, attempts, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', 0, $7) RETURNING ${DELIVERY_COLUMNS}`,
      [newUuid(), delivery.endpointId, delivery.organizationId, delivery.outboxEventId, delivery.eventType, JSON.stringify(delivery.payload), MAX_DELIVERY_ATTEMPTS],
    );
    return row as WebhookDeliveryRow;
  }

  /** Claim pending deliveries whose backoff has elapsed; SKIP LOCKED so N workers never double-POST. */
  async claimDue(tx: Tx, limit: number): Promise<string[]> {
    const rows = await tx.rows<{ id: string }>(
      `SELECT id FROM webhook_deliveries
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows.map((row) => row.id);
  }

  findById(tx: Tx, id: string): Promise<WebhookDeliveryRow | undefined> {
    return tx.one<WebhookDeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE id = $1`, [id]);
  }

  async update(tx: Tx, id: string, patch: DeliveryPatch): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([column], index) => `${column} = $${String(index + 2)}`);
    await tx.query(`UPDATE webhook_deliveries SET ${sets.join(", ")} WHERE id = $1`, [id, ...entries.map(([, value]) => value)]);
  }
}
