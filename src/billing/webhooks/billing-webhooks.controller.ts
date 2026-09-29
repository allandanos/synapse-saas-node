import { Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { NotFoundError } from "../../core/errors";
import { Public } from "../../identity/public.decorator";
import { isBillingProviderName, type WebhookRequest } from "../providers";
import { BillingWebhooksService, type WebhookOutcome } from "./billing-webhooks.service";

/**
 * Provider → us. Unauthenticated by design: the signature over the RAW body is
 * the credential, which is why `express.raw` is mounted on this path ahead of
 * the JSON parser (see `configureHttp`).
 */
@Public()
@Controller("v1/billing/webhooks")
export class BillingWebhooksController {
  constructor(private readonly webhooks: BillingWebhooksService) {}

  @Post(":provider")
  @HttpCode(200)
  ingest(@Param("provider") provider: string, @Req() request: Request): Promise<WebhookOutcome> {
    if (!isBillingProviderName(provider)) throw new NotFoundError("Unknown billing provider");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? "") : value;
    }
    const raw: WebhookRequest = { headers, body: Buffer.isBuffer(request.body) ? request.body : Buffer.from("") };
    return this.webhooks.handle(provider, raw);
  }
}
