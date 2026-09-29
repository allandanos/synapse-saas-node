import { Module } from "@nestjs/common";
import { WebhookDeliveriesRepository } from "./deliveries.repository";
import { DELIVERY_FETCH, WebhookDeliveryService } from "./delivery.service";

/**
 * Outbound webhooks: the delivery rows the outbox fans out to, and the signed
 * POST that drains them. Endpoint management routes arrive with milestone 5.
 * `DELIVERY_FETCH` is a provider so tests can point deliveries at a stub.
 */
@Module({
  providers: [WebhookDeliveriesRepository, WebhookDeliveryService, { provide: DELIVERY_FETCH, useValue: fetch }],
  exports: [WebhookDeliveriesRepository, WebhookDeliveryService],
})
export class WebhooksModule {}
