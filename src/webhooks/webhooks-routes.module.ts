import { Module } from "@nestjs/common";
import { AuthorizationModule } from "../authorization/authorization.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { WebhookEndpointsRepository } from "./endpoints.repository";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

/** `/v1/webhooks/*` — endpoint CRUD and the delivery log over the `WebhooksModule` engine. */
@Module({
  imports: [AuthorizationModule, TenancyModule],
  controllers: [WebhooksController],
  providers: [WebhookEndpointsRepository, WebhooksService],
  exports: [WebhookEndpointsRepository, WebhooksService],
})
export class WebhooksRoutesModule {}
