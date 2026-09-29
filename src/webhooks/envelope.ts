/**
 * Outbound webhook constants and the delivery envelope — the shape tenants
 * sign against, shared by the worker and (from milestone 5) the endpoint
 * management routes.
 */

export const SIGNATURE_HEADER = "X-Synapse-Signature";
export const DELIVERY_TIMEOUT_MS = 10_000;

/** 1m, 5m, 30m, 2h, 6h — then the delivery is exhausted. */
export const DELIVERY_BACKOFF_SECONDS: readonly number[] = [60, 300, 1800, 7200, 21600];
export const MAX_DELIVERY_ATTEMPTS = DELIVERY_BACKOFF_SECONDS.length + 1;

export interface DeliveryEnvelope {
  id: string;
  event_type: string;
  organization_id: string;
  created_at: string;
  data: Record<string, unknown>;
}

export function buildEnvelope(delivery: { id: string; event_type: string; organization_id: string; payload: Record<string, unknown> }, now = new Date()): DeliveryEnvelope {
  return {
    id: delivery.id,
    event_type: delivery.event_type,
    organization_id: delivery.organization_id,
    created_at: now.toISOString(),
    data: delivery.payload,
  };
}

/** The attempt's wait, clamped to the last rung of the ladder. */
export function deliveryBackoffSeconds(attempts: number): number {
  return DELIVERY_BACKOFF_SECONDS[Math.min(attempts - 1, DELIVERY_BACKOFF_SECONDS.length - 1)] as number;
}
