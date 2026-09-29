import { Injectable } from "@nestjs/common";
import type { Tx } from "../core/db/database";
import { newUuid } from "../core/ids";
import type { WebhookDeliveryRow } from "./deliveries.repository";

export interface WebhookEndpointFullRow {
  id: string;
  organization_id: string;
  url: string;
  secret_encrypted: Buffer;
  description: string | null;
  events: string[];
  is_active: boolean;
  created_at: Date;
}

/** The wire shape: the encrypted secret never leaves the database after creation. */
export interface WebhookEndpointRead {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  is_active: boolean;
  created_at: Date;
}

export function toEndpointRead(row: WebhookEndpointFullRow): WebhookEndpointRead {
  return { id: row.id, url: row.url, description: row.description, events: row.events, is_active: row.is_active, created_at: row.created_at };
}

export interface WebhookDeliveryRead {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  last_response_code: number | null;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export function toDeliveryRead(row: WebhookDeliveryRow): WebhookDeliveryRead {
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at,
    last_response_code: row.last_response_code,
    last_error: row.last_error,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
  };
}

const COLUMNS = "id, organization_id, url, secret_encrypted, description, events, is_active, created_at";

/** Endpoint rows, org-scoped. Deliveries live in `WebhookDeliveriesRepository`. */
@Injectable()
export class WebhookEndpointsRepository {
  async insert(
    tx: Tx,
    endpoint: { organizationId: string; url: string; secretEncrypted: Buffer; description: string | null; events: string[] },
  ): Promise<WebhookEndpointFullRow> {
    const row = await tx.one<WebhookEndpointFullRow>(
      `INSERT INTO webhook_endpoints (id, organization_id, url, secret_encrypted, description, events, is_active)
       VALUES ($1, $2, $3, $4, $5, $6::text[], true) RETURNING ${COLUMNS}`,
      [newUuid(), endpoint.organizationId, endpoint.url, endpoint.secretEncrypted, endpoint.description, endpoint.events],
    );
    return row as WebhookEndpointFullRow;
  }

  /** Deterministic order (`created_at` desc, id): the route pages this in memory. */
  listForOrg(tx: Tx, organizationId: string): Promise<WebhookEndpointFullRow[]> {
    return tx.rows<WebhookEndpointFullRow>(
      `SELECT ${COLUMNS} FROM webhook_endpoints WHERE organization_id = $1 ORDER BY created_at DESC, id`,
      [organizationId],
    );
  }

  findScoped(tx: Tx, id: string, organizationId: string): Promise<WebhookEndpointFullRow | undefined> {
    return tx.one<WebhookEndpointFullRow>(`SELECT ${COLUMNS} FROM webhook_endpoints WHERE id = $1 AND organization_id = $2`, [id, organizationId]);
  }

  /** Hard delete: `webhook_deliveries.endpoint_id` cascades, like the reference's `session.delete`. */
  async remove(tx: Tx, id: string): Promise<void> {
    await tx.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [id]);
  }

  /** Deliveries for the org, newest first, counted and sliced in the database. */
  async pageDeliveries(
    tx: Tx,
    organizationId: string,
    filters: { endpointId?: string | null; limit: number; offset: number },
  ): Promise<{ rows: WebhookDeliveryRow[]; total: number }> {
    const where = ["organization_id = $1"];
    const params: unknown[] = [organizationId];
    if (filters.endpointId) {
      params.push(filters.endpointId);
      where.push(`endpoint_id = $${String(params.length)}`);
    }
    const clause = where.join(" AND ");
    const counted = await tx.one<{ total: string }>(`SELECT count(*)::text AS total FROM webhook_deliveries WHERE ${clause}`, params);
    const rows = await tx.rows<WebhookDeliveryRow>(
      `SELECT id, endpoint_id, organization_id, outbox_event_id, event_type, payload, status, attempts, max_attempts,
              next_attempt_at, last_response_code, last_error, response_excerpt, delivered_at, created_at
         FROM webhook_deliveries WHERE ${clause}
        ORDER BY created_at DESC LIMIT $${String(params.length + 1)} OFFSET $${String(params.length + 2)}`,
      [...params, filters.limit, filters.offset],
    );
    return { rows, total: Number(counted?.total ?? 0) };
  }

  findDeliveryScoped(tx: Tx, id: string, organizationId: string): Promise<WebhookDeliveryRow | undefined> {
    return tx.one<WebhookDeliveryRow>(
      `SELECT id, endpoint_id, organization_id, outbox_event_id, event_type, payload, status, attempts, max_attempts,
              next_attempt_at, last_response_code, last_error, response_excerpt, delivered_at, created_at
         FROM webhook_deliveries WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
  }

  /** Put a delivery back at the head of the queue: pending, attempt count cleared, due now. */
  async resetForRetry(tx: Tx, id: string): Promise<WebhookDeliveryRow> {
    const row = await tx.one<WebhookDeliveryRow>(
      `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1
       RETURNING id, endpoint_id, organization_id, outbox_event_id, event_type, payload, status, attempts, max_attempts,
                 next_attempt_at, last_response_code, last_error, response_excerpt, delivered_at, created_at`,
      [id],
    );
    return row as WebhookDeliveryRow;
  }
}
