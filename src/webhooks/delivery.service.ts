import { Inject, Injectable, Logger } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import type { Tx } from "../core/db/database";
import { WebhookDeliveriesRepository, type WebhookDeliveryRow } from "./deliveries.repository";
import { buildEnvelope, DELIVERY_TIMEOUT_MS, deliveryBackoffSeconds, MAX_DELIVERY_ATTEMPTS } from "./envelope";
import { fernetDecrypt } from "./fernet";
import { signatureHeader } from "./signer";

export type DeliveryFetch = (url: string, init?: RequestInit) => Promise<Response>;
export const DELIVERY_FETCH = Symbol("DELIVERY_FETCH");

const EXCERPT_LENGTH = 500;

/**
 * Signed outbound delivery with backoff. One attempt per call; the worker
 * claims the rows and owns the transaction, so a delivery is POSTed exactly
 * once per tick even with several workers running.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly deliveries: WebhookDeliveriesRepository,
    @Inject(DELIVERY_FETCH) private readonly fetchImpl: DeliveryFetch,
  ) {}

  /** Attempt one delivery. Returns whether the endpoint accepted it. */
  async deliver(tx: Tx, deliveryId: string): Promise<boolean> {
    const delivery = await this.deliveries.findById(tx, deliveryId);
    if (!delivery) return false;
    const endpoint = await this.deliveries.findEndpoint(tx, delivery.endpoint_id);
    if (!endpoint || !endpoint.is_active) {
      await this.deliveries.update(tx, delivery.id, { status: "failed", last_error: "endpoint removed or inactive" });
      return false;
    }

    const body = Buffer.from(JSON.stringify(buildEnvelope(delivery)), "utf8");
    const signature = signatureHeader(body, fernetDecrypt(endpoint.secret_encrypted, this.settings.SYNAPSE_SECRET_KEY));

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", [signature.name]: signature.value },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
    } catch (error) {
      await this.markFailure(tx, delivery, null, error instanceof Error ? error.message : String(error));
      return false;
    }

    const excerpt = (await response.text()).slice(0, EXCERPT_LENGTH);
    if (response.status >= 200 && response.status < 300) {
      await this.deliveries.update(tx, delivery.id, {
        status: "delivered",
        delivered_at: new Date(),
        last_response_code: response.status,
        response_excerpt: excerpt,
      });
      return true;
    }
    await this.markFailure(tx, delivery, response.status, excerpt);
    return false;
  }

  private async markFailure(tx: Tx, delivery: WebhookDeliveryRow, code: number | null, error: string): Promise<void> {
    const attempts = delivery.attempts + 1;
    const ceiling = Math.min(delivery.max_attempts, MAX_DELIVERY_ATTEMPTS);
    const exhausted = attempts >= ceiling;
    await this.deliveries.update(tx, delivery.id, {
      attempts,
      last_response_code: code,
      last_error: error.slice(0, EXCERPT_LENGTH),
      ...(exhausted ? { status: "exhausted" as const } : { next_attempt_at: new Date(Date.now() + deliveryBackoffSeconds(attempts) * 1000) }),
    });
    if (exhausted) this.logger.warn(`webhook delivery exhausted id=${delivery.id} endpoint=${delivery.endpoint_id} attempts=${String(attempts)}`);
  }
}
