import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { PageQuery, sliceInMemory, TOTAL_COUNT_HEADER } from "../core/pagination";
import { RequestContext } from "../core/request-context";
import { UuidPipe } from "../core/validation";
import { TenantGuard } from "../tenancy/tenant.guard";
import type { WebhookDeliveryRead, WebhookEndpointRead } from "./endpoints.repository";
import { DeliveryQuery, WebhookEndpointCreate, normaliseHttpUrl } from "./webhooks.dto";
import { WebhooksService } from "./webhooks.service";

/**
 * Tenant-facing webhook management: endpoints and their delivery log.
 * One permission (`webhook:manage`) covers the family — reading the delivery
 * log tells you as much about an endpoint as editing it does.
 */
@Controller("v1/webhooks")
@UseGuards(TenantGuard, PermissionsGuard)
@RequirePermission("webhook:manage")
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly context: RequestContext,
  ) {}

  @Get("endpoints")
  async listEndpoints(@Query() page: PageQuery, @Res({ passthrough: true }) res: Response): Promise<WebhookEndpointRead[]> {
    const endpoints = await this.webhooks.listEndpoints(this.context.requireTenant().organizationId);
    const { items, total } = sliceInMemory(endpoints, page);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items;
  }

  /** The only response that ever carries the plaintext secret. */
  @Post("endpoints")
  @HttpCode(201)
  createEndpoint(@Body() body: WebhookEndpointCreate): Promise<WebhookEndpointRead & { secret: string }> {
    return this.webhooks.createEndpoint(this.context.requireTenant().organizationId, {
      url: normaliseHttpUrl(body.url) as string,
      events: body.events ?? [],
      description: body.description ?? null,
    });
  }

  @Delete("endpoints/:endpointId")
  @HttpCode(204)
  deleteEndpoint(@Param("endpointId", UuidPipe) endpointId: string): Promise<void> {
    return this.webhooks.deleteEndpoint(this.context.requireTenant().organizationId, endpointId);
  }

  @Get("deliveries")
  async listDeliveries(@Query() query: DeliveryQuery, @Res({ passthrough: true }) res: Response): Promise<WebhookDeliveryRead[]> {
    const { items, total } = await this.webhooks.listDeliveries(this.context.requireTenant().organizationId, {
      endpointId: query.endpoint_id ?? null,
      limit: query.limit,
      offset: query.offset,
    });
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items;
  }

  @Post("deliveries/:deliveryId/retry")
  @HttpCode(200)
  retryDelivery(@Param("deliveryId", UuidPipe) deliveryId: string): Promise<WebhookDeliveryRead> {
    return this.webhooks.retryDelivery(this.context.requireTenant().organizationId, deliveryId);
  }
}
