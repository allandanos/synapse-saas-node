import { randomBytes } from "node:crypto";
import { WebhookSignatureInvalidError } from "../../core/errors";
import { verifySignature } from "../../core/security";
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
import { basicAuth, ProviderHttp, record } from "./http";
import { asInt, asString, parseJsonBody } from "./manual.provider";

export const PAYMONGO_API_BASE = "https://api.paymongo.com/v1";
export const PAYMONGO_WEBHOOK_TOLERANCE_SECONDS = 300;
const THIRTY_DAYS_MS = 30 * 86_400_000;

export interface PayMongoOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiBase?: string;
  readonly currency?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * PayMongo (PH) — cards, GCash and Maya through Checkout Sessions. Amounts are
 * already minor units (centavos). Webhooks use the same `t=…,v1=…` HMAC-SHA256
 * scheme as Stripe over the raw body, under the header `Paymongo-Signature`.
 */
export class PayMongoBillingProvider implements BillingProvider {
  readonly name = "paymongo" as const;
  readonly supports = PROVIDER_CAPABILITIES.paymongo;

  private readonly http: ProviderHttp;
  private readonly webhookSecret: string;
  private readonly currency: string;

  constructor(options: PayMongoOptions) {
    this.webhookSecret = options.webhookSecret;
    this.currency = options.currency ?? "PHP";
    this.http = new ProviderHttp({
      fetchImpl: options.fetchImpl ?? fetch,
      baseUrl: options.apiBase ?? PAYMONGO_API_BASE,
      provider: this.name,
      authHeader: basicAuth(options.secretKey),
    });
  }

  createCustomer(req: CreateCustomerRequest): Promise<BillingCustomerRef> {
    // PayMongo has no first-class customer object; we mint a stable reference.
    return Promise.resolve({
      providerCustomerId: `paymongo_${randomBytes(8).toString("hex")}`,
      email: req.email,
      name: req.name ?? null,
    });
  }

  async createCheckout(req: CreateCheckoutRequest): Promise<CheckoutResult> {
    const result = await this.http.json("POST", "/checkout_sessions", {
      data: {
        attributes: {
          line_items: [{ name: req.planName, amount: req.priceCents, currency: req.currency, quantity: 1 }],
          metadata: { plan_key: req.planKey, org_id: req.organizationId ?? "" },
        },
      },
    });
    const data = record(result.data);
    const attributes = record(data.attributes);
    return { url: asString(attributes.checkout_url), provider: this.name, providerCheckoutId: String(data.id ?? "") };
  }

  billingPortalUrl(): Promise<string> {
    return Promise.reject(new Error(`${this.name} does not support billing portals`));
  }

  createSubscription(req: CreateSubscriptionRequest): Promise<SubscriptionRef> {
    return Promise.resolve({
      providerSubscriptionId: `paymongosub_${randomBytes(8).toString("hex")}`,
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
    return Promise.resolve([]); // PayMongo surfaces payments, not invoices; we record locally
  }

  verifyWebhook(raw: WebhookRequest): Promise<VerifiedWebhook> {
    const header = raw.headers["paymongo-signature"] ?? "";
    let timestamp: number | null = null;
    let signature: string | null = null;
    for (const part of header.split(",")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key === "t") {
        const parsed = Number.parseInt(value, 10);
        timestamp = Number.isInteger(parsed) ? parsed : null;
      } else if (key === "v1" && value) signature = value;
    }
    if (timestamp === null || signature === null) throw new WebhookSignatureInvalidError("Malformed Paymongo-Signature header");
    if (Math.abs(Date.now() / 1000 - timestamp) > PAYMONGO_WEBHOOK_TOLERANCE_SECONDS) {
      throw new WebhookSignatureInvalidError("PayMongo webhook timestamp outside tolerance");
    }
    if (!verifySignature(raw.body, this.webhookSecret, timestamp, signature)) {
      throw new WebhookSignatureInvalidError("PayMongo webhook signature mismatch");
    }
    const parsed = parseJsonBody(raw.body, "PayMongo");
    const attributes = record(record(parsed.data).attributes);
    return Promise.resolve({
      providerEventId: String(parsed.id ?? `paymongo_${randomBytes(8).toString("hex")}`),
      eventType: String(parsed.type ?? attributes.type ?? ""),
      parsed,
      receivedAt: new Date(),
    });
  }

  translateWebhook(verified: VerifiedWebhook): NormalizedBillingEvent[] {
    const typeMap: Record<string, NormalizedBillingEvent["eventType"]> = {
      "checkout_session.completed": BillingEventType.CHECKOUT_COMPLETED,
      "payment.paid": BillingEventType.INVOICE_PAID,
      "payment.failed": BillingEventType.PAYMENT_FAILED,
    };
    const canonical = typeMap[verified.eventType];
    if (!canonical) return [];
    const attributes = record(record(verified.parsed.data).attributes);
    const lineItems = Array.isArray(attributes.line_items) ? attributes.line_items : [];
    let amountCents: number | null = null;
    for (const item of lineItems) {
      const amount = asInt(record(item).amount);
      if (amount !== null && amount !== 0) {
        amountCents = amount;
        break;
      }
    }
    amountCents ??= asInt(attributes.amount);
    const metadata = record(attributes.metadata);
    return [
      {
        eventType: canonical,
        providerEventId: verified.providerEventId,
        occurredAt: verified.receivedAt,
        planKey: asString(metadata.plan_key),
        amountCents,
        currency: asString(metadata.currency) ?? this.currency,
        raw: verified.parsed,
      },
    ];
  }
}
