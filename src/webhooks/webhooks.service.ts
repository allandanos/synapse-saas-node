import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { Database } from "../core/db/database";
import { WebhookDeliveryNotFoundError, WebhookEndpointNotFoundError } from "../core/errors";
import { fernetEncrypt } from "./fernet";
import {
  type WebhookDeliveryRead,
  type WebhookEndpointRead,
  WebhookEndpointsRepository,
  toDeliveryRead,
  toEndpointRead,
} from "./endpoints.repository";

/** 24 random bytes, url-safe — the same entropy as the reference's `secrets.token_urlsafe(24)`. */
const SECRET_BYTES = 24;

export function mintEndpointSecret(random: (size: number) => Buffer = randomBytes): string {
  return `whsec_${random(SECRET_BYTES).toString("base64url")}`;
}

/**
 * Endpoint management over the milestone-4 delivery engine.
 *
 * The plaintext secret exists for exactly one response: it is minted here,
 * Fernet-encrypted under `SYNAPSE_SECRET_KEY` before it touches a column, and
 * returned once. Nothing reads it back but the worker, at delivery time.
 * Rows are org-scoped by construction, so a foreign id is a 404 rather than a
 * 403 — the API never confirms that another tenant's endpoint exists.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly db: Database,
    private readonly endpoints: WebhookEndpointsRepository,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  createEndpoint(
    organizationId: string,
    input: { url: string; events: string[]; description: string | null },
  ): Promise<WebhookEndpointRead & { secret: string }> {
    const secret = mintEndpointSecret();
    return this.db.transaction(async (tx) => {
      const row = await this.endpoints.insert(tx, {
        organizationId,
        url: input.url,
        secretEncrypted: fernetEncrypt(secret, this.settings.SYNAPSE_SECRET_KEY),
        description: input.description,
        events: input.events,
      });
      return { ...toEndpointRead(row), secret };
    });
  }

  async listEndpoints(organizationId: string): Promise<WebhookEndpointRead[]> {
    return (await this.db.transaction((tx) => this.endpoints.listForOrg(tx, organizationId))).map(toEndpointRead);
  }

  deleteEndpoint(organizationId: string, endpointId: string): Promise<void> {
    return this.db.transaction(async (tx) => {
      const row = await this.endpoints.findScoped(tx, endpointId, organizationId);
      if (!row) throw new WebhookEndpointNotFoundError("Webhook endpoint not found");
      await this.endpoints.remove(tx, endpointId);
    });
  }

  async listDeliveries(
    organizationId: string,
    filters: { endpointId?: string | null; limit: number; offset: number },
  ): Promise<{ items: WebhookDeliveryRead[]; total: number }> {
    const page = await this.db.transaction((tx) => this.endpoints.pageDeliveries(tx, organizationId, filters));
    return { items: page.rows.map(toDeliveryRead), total: page.total };
  }

  /**
   * Replay a delivery: back to `pending`, attempts cleared, due immediately.
   * Any status may be retried — a delivered webhook the receiver lost is as
   * legitimate a replay as an exhausted one.
   */
  retryDelivery(organizationId: string, deliveryId: string): Promise<WebhookDeliveryRead> {
    return this.db.transaction(async (tx) => {
      const row = await this.endpoints.findDeliveryScoped(tx, deliveryId, organizationId);
      if (!row) throw new WebhookDeliveryNotFoundError("Delivery not found");
      return toDeliveryRead(await this.endpoints.resetForRetry(tx, deliveryId));
    });
  }
}
