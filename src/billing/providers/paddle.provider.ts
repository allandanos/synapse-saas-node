import { randomBytes } from "node:crypto";
import { WebhookSignatureInvalidError } from "../../core/errors";
import { constantTimeEquals, signPayloadColon } from "../../core/security";
import {
  type BillingCustomerRef,
  BillingEventType,
  type BillingProvider,
  type CheckoutResult,
  type CreateCheckoutRequest,
  type CreateCustomerRequest,
  type CreateSubscriptionRequest,
  type FetchLike,
  type InvoiceRef,
  type NormalizedBillingEvent,
  PROVIDER_CAPABILITIES,
  type SubscriptionRef,
  type VerifiedWebhook,
  type WebhookRequest,
} from "../providers";
import { ProviderHttp, record } from "./http";
import { asInt, asString, parseJsonBody } from "./manual.provider";

export const PADDLE_API_BASE = "https://api.paddle.com";
export const PADDLE_WEBHOOK_TOLERANCE_SECONDS = 300;
const THIRTY_DAYS_MS = 30 * 86_400_000;

export interface PaddleOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiBase?: string;
  readonly currency?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * Paddle Billing: hosted checkout via transactions, notifications signed with
 * `Paddle-Signature: ts=<unix>;h1=<hex>` over `"{ts}:" + rawBody` (a colon, not
 * Stripe's dot). Recurring is scheduler-backed like Xendit/PayMongo, and the
 * capability set says so.
 */
export class PaddleBillingProvider implements BillingProvider {
  readonly name = "paddle" as const;
  readonly supports = PROVIDER_CAPABILITIES.paddle;

  private readonly http: ProviderHttp;
  private readonly webhookSecret: string;

  constructor(options: PaddleOptions) {
    this.webhookSecret = options.webhookSecret;
    this.http = new ProviderHttp({
      fetchImpl: options.fetchImpl ?? fetch,
      baseUrl: options.apiBase ?? PADDLE_API_BASE,
      provider: this.name,
      authHeader: `Bearer ${options.secretKey}`,
    });
  }

  async createCustomer(req: CreateCustomerRequest): Promise<BillingCustomerRef> {
    const result = await this.http.json("POST", "/customers", { email: req.email, name: req.name ?? null });
    const data = record(result.data ?? result);
    return { providerCustomerId: String(data.id ?? ""), email: req.email, name: req.name ?? null };
  }

  async createCheckout(req: CreateCheckoutRequest): Promise<CheckoutResult> {
    // Paddle prices live in the dashboard; the plan rides in custom_data and
    // the items shape carries the dynamic price.
    const result = await this.http.json("POST", "/transactions", {
      items: [
        {
          price: { unit_amount: req.priceCents, currency_code: req.currency.toLowerCase(), product: { name: req.planName } },
          quantity: 1,
        },
      ],
      custom_data: { plan_key: req.planKey, org_id: req.organizationId ?? "" },
    });
    const data = record(result.data ?? result);
    return { url: asString(record(data.checkout).url), provider: this.name, providerCheckoutId: String(data.id ?? "") };
  }

  billingPortalUrl(): Promise<string> {
    return Promise.reject(new Error(`${this.name} does not support billing portals`));
  }

  createSubscription(req: CreateSubscriptionRequest): Promise<SubscriptionRef> {
    return Promise.resolve({
      providerSubscriptionId: `paddlesub_${randomBytes(8).toString("hex")}`,
      status: "active",
      currentPeriodEnd: new Date(Date.now() + THIRTY_DAYS_MS),
      providerCustomerId: req.providerCustomerId,
    });
  }

  changePlan(providerSubscriptionId: string): Promise<SubscriptionRef> {
    return Promise.resolve({ providerSubscriptionId, status: "active", currentPeriodEnd: new Date(Date.now() + THIRTY_DAYS_MS) });
  }

  cancelSubscription(providerSubscriptionId: string): Promise<SubscriptionRef> {
    return Promise.resolve({ providerSubscriptionId, status: "canceled" });
  }

  getSubscription(providerSubscriptionId: string): Promise<SubscriptionRef> {
    return Promise.resolve({ providerSubscriptionId, status: "active", currentPeriodEnd: new Date(Date.now() + THIRTY_DAYS_MS) });
  }

  listInvoices(): Promise<InvoiceRef[]> {
    return Promise.resolve([]);
  }

  verifyWebhook(raw: WebhookRequest): Promise<VerifiedWebhook> {
    const parsed = parseJsonBody(raw.body, "Paddle");
    const header = raw.headers["paddle-signature"] ?? "";
    // Semicolon-separated per the spec; a comma is tolerated for proxies that rewrite it.
    const parts = new Map<string, string>();
    for (const part of header.split(/[;,]/)) {
      const index = part.indexOf("=");
      if (index > 0) parts.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
    const tsRaw = parts.get("ts");
    const h1 = parts.get("h1");
    if (tsRaw !== undefined && h1 !== undefined && this.webhookSecret) {
      const timestamp = Number.parseInt(tsRaw, 10);
      if (!Number.isInteger(timestamp)) throw new WebhookSignatureInvalidError("Bad Paddle timestamp");
      if (Math.abs(Date.now() / 1000 - timestamp) > PADDLE_WEBHOOK_TOLERANCE_SECONDS) {
        throw new WebhookSignatureInvalidError("Paddle webhook timestamp outside tolerance");
      }
      if (constantTimeEquals(signPayloadColon(raw.body, this.webhookSecret, timestamp), h1)) {
        return Promise.resolve({
          providerEventId: String(parsed.event_id ?? `paddle_${randomBytes(8).toString("hex")}`),
          eventType: String(parsed.event_type ?? ""),
          parsed,
          receivedAt: new Date(),
        });
      }
    }
    if (!this.webhookSecret) throw new WebhookSignatureInvalidError("Paddle webhook secret not configured");
    throw new WebhookSignatureInvalidError("Paddle webhook signature mismatch");
  }

  translateWebhook(verified: VerifiedWebhook): NormalizedBillingEvent[] {
    const typeMap: Record<string, NormalizedBillingEvent["eventType"]> = {
      "transaction.completed": BillingEventType.CHECKOUT_COMPLETED,
      "subscription.activated": BillingEventType.SUBSCRIPTION_ACTIVATED,
      "subscription.updated": BillingEventType.SUBSCRIPTION_UPDATED,
      "subscription.canceled": BillingEventType.SUBSCRIPTION_CANCELED,
      "subscription.past_due": BillingEventType.SUBSCRIPTION_PAST_DUE,
    };
    const canonical = typeMap[verified.eventType];
    if (!canonical) return [];
    const data = record(verified.parsed.data);
    const custom = record(data.custom_data);
    const isSubscriptionEvent = verified.eventType.includes("subscription");
    return [
      {
        eventType: canonical,
        providerEventId: verified.providerEventId,
        occurredAt: verified.receivedAt,
        providerCustomerId: asString(data.customer_id),
        providerSubscriptionId: isSubscriptionEvent ? asString(data.id) : asString(data.subscription_id),
        planKey: asString(custom.plan_key),
        status: asString(data.status),
        amountCents: asInt(record(data.totals).total) ?? intFromDigits(record(data.totals).total),
        currency: asString(data.currency_code)?.toUpperCase() ?? null,
        raw: verified.parsed,
      },
    ];
  }
}

/** Paddle sends totals as decimal strings in minor units; parse, never multiply a float. */
function intFromDigits(value: unknown): number | null {
  return typeof value === "string" && /^-?\d+$/.test(value) ? Number.parseInt(value, 10) : null;
}
