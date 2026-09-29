import { WebhookSignatureInvalidError } from "../../core/errors";
import { verifySignature } from "../../core/security";
import {
  type BillingCustomerRef,
  BillingEventType,
  type BillingProvider,
  type ChangePlanRequest,
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
import { basicAuth, fromUnixSeconds, type JsonObject, ProviderHttp, record } from "./http";
import { asInt, asString, parseJsonBody } from "./manual.provider";

export const STRIPE_API_BASE = "https://api.stripe.com/v1";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly apiBase?: string;
  readonly currency?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * Stripe over plain `fetch` — no SDK, so every provider stays uniform and the
 * signature scheme is testable against a local stub. Endpoints, the
 * form-encoded dialect and the webhook scheme follow Stripe's public API.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = "stripe" as const;
  readonly supports = PROVIDER_CAPABILITIES.stripe;

  private readonly http: ProviderHttp;
  private readonly webhookSecret: string;

  constructor(options: StripeOptions) {
    this.webhookSecret = options.webhookSecret;
    this.http = new ProviderHttp({
      fetchImpl: options.fetchImpl ?? fetch,
      baseUrl: options.apiBase ?? STRIPE_API_BASE,
      provider: this.name,
      authHeader: basicAuth(options.secretKey),
    });
  }

  async createCustomer(req: CreateCustomerRequest): Promise<BillingCustomerRef> {
    const result = await this.http.form("POST", "/customers", {
      email: req.email,
      name: req.name,
      "metadata[org]": req.organizationId ?? "",
    });
    return { providerCustomerId: String(result.id), email: req.email, name: req.name ?? null };
  }

  async createCheckout(req: CreateCheckoutRequest): Promise<CheckoutResult> {
    const data: Record<string, unknown> = {
      mode: "subscription",
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": req.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": req.priceCents,
      "line_items[0][price_data][recurring][interval]": req.interval,
      "line_items[0][price_data][product_data][name]": req.planName,
      "metadata[plan_key]": req.planKey,
      "metadata[org_id]": req.organizationId ?? "",
      customer: req.providerCustomerId,
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
    };
    const result = await this.http.form("POST", "/checkout/sessions", data);
    return { url: asString(result.url), provider: this.name, providerCheckoutId: String(result.id) };
  }

  async billingPortalUrl(providerCustomerId: string, returnUrl: string): Promise<string> {
    const result = await this.http.form("POST", "/billing_portal/sessions", { customer: providerCustomerId, return_url: returnUrl });
    return String(result.url);
  }

  async createSubscription(req: CreateSubscriptionRequest): Promise<SubscriptionRef> {
    const data: Record<string, unknown> = {
      customer: req.providerCustomerId,
      "items[0][price_data][currency]": req.currency.toLowerCase(),
      "items[0][price_data][unit_amount]": req.priceCents,
      "items[0][price_data][recurring][interval]": req.interval,
      "items[0][price_data][product_data][name]": req.planKey,
      "metadata[plan_key]": req.planKey,
    };
    if (req.trialDays) data.trial_period_days = req.trialDays;
    return toSubscriptionRef(await this.http.form("POST", "/subscriptions", data));
  }

  async changePlan(providerSubscriptionId: string, req: ChangePlanRequest): Promise<SubscriptionRef> {
    const current = await this.http.form("GET", `/subscriptions/${providerSubscriptionId}`);
    const items = record(current.items).data;
    const itemId = Array.isArray(items) ? String(record(items[0]).id ?? "") : "";
    const result = await this.http.form("POST", `/subscriptions/${providerSubscriptionId}`, {
      "items[0][id]": itemId,
      "items[0][price_data][currency]": req.currency.toLowerCase(),
      "items[0][price_data][unit_amount]": req.priceCents,
      "items[0][price_data][recurring][interval]": req.interval,
      "metadata[plan_key]": req.planKey,
    });
    return toSubscriptionRef(result);
  }

  async cancelSubscription(providerSubscriptionId: string, atPeriodEnd = true): Promise<SubscriptionRef> {
    // POST with the flag in the form body; Stripe ignores query params here.
    const result = atPeriodEnd
      ? await this.http.form("POST", `/subscriptions/${providerSubscriptionId}`, { cancel_at_period_end: true })
      : await this.http.form("DELETE", `/subscriptions/${providerSubscriptionId}`);
    return toSubscriptionRef(result);
  }

  async getSubscription(providerSubscriptionId: string): Promise<SubscriptionRef> {
    return toSubscriptionRef(await this.http.form("GET", `/subscriptions/${providerSubscriptionId}`));
  }

  async listInvoices(providerCustomerId: string, limit = 20): Promise<InvoiceRef[]> {
    const result = await this.http.form("GET", `/invoices?customer=${providerCustomerId}&limit=${String(limit)}`);
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map((item) => toInvoiceRef(record(item)));
  }

  verifyWebhook(raw: WebhookRequest): Promise<VerifiedWebhook> {
    const { timestamp, signature } = parseStripeSignature(raw.headers["stripe-signature"] ?? "");
    if (timestamp === null || signature === null) throw new WebhookSignatureInvalidError("Malformed Stripe-Signature header");
    if (Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
      throw new WebhookSignatureInvalidError("Stripe webhook timestamp outside tolerance window");
    }
    if (!verifySignature(raw.body, this.webhookSecret, timestamp, signature)) {
      throw new WebhookSignatureInvalidError("Stripe webhook signature mismatch");
    }
    const parsed = parseJsonBody(raw.body, "Stripe");
    return Promise.resolve({
      providerEventId: String(parsed.id ?? ""),
      eventType: String(parsed.type ?? ""),
      parsed,
      receivedAt: new Date(),
    });
  }

  translateWebhook(verified: VerifiedWebhook): NormalizedBillingEvent[] {
    const typeMap: Record<string, NormalizedBillingEvent["eventType"]> = {
      "customer.subscription.created": BillingEventType.SUBSCRIPTION_CREATED,
      "customer.subscription.updated": BillingEventType.SUBSCRIPTION_UPDATED,
      "customer.subscription.deleted": BillingEventType.SUBSCRIPTION_CANCELED,
      "invoice.paid": BillingEventType.INVOICE_PAID,
      "invoice.payment_failed": BillingEventType.INVOICE_FAILED,
      "checkout.session.completed": BillingEventType.CHECKOUT_COMPLETED,
    };
    const canonical = typeMap[verified.eventType];
    if (!canonical) return [];

    const data = record(record(verified.parsed.data).object);
    const occurredAt = fromUnixSeconds(verified.parsed.created) ?? verified.receivedAt;
    const statuses = new Set(["trialing", "active", "past_due", "canceled", "unpaid", "incomplete"]);
    const status = asString(data.status);
    const isSubscriptionEvent = verified.eventType.includes("subscription");
    return [
      {
        eventType: canonical,
        providerEventId: verified.providerEventId,
        occurredAt,
        providerCustomerId: asString(data.customer),
        providerSubscriptionId: isSubscriptionEvent ? asString(data.id) : asString(data.subscription),
        providerInvoiceId: verified.eventType.includes("invoice") ? asString(data.id) : null,
        planKey: asString(record(data.metadata).plan_key),
        status: status !== null && statuses.has(status) ? status : null,
        currentPeriodEnd: fromUnixSeconds(data.current_period_end),
        amountCents: asInt(data.amount_paid) ?? asInt(data.amount_due),
        currency: asString(data.currency)?.toUpperCase() ?? null,
        hostedUrl: asString(data.hosted_invoice_url),
        raw: verified.parsed,
      },
    ];
  }

  /** Plan sync (CLI): create (or reuse) a product+price for a plan. */
  async upsertProductAndPrice(input: { planKey: string; planName: string; priceCents: number; currency: string; interval: string }): Promise<{ product_id: string; price_id: string }> {
    const product = await this.http.form("POST", "/products", { name: input.planName, "metadata[plan_key]": input.planKey });
    const price = await this.http.form("POST", "/prices", {
      product: product.id,
      currency: input.currency.toLowerCase(),
      unit_amount: input.priceCents,
      "recurring[interval]": input.interval,
    });
    return { product_id: String(product.id), price_id: String(price.id) };
  }
}

function toSubscriptionRef(data: JsonObject): SubscriptionRef {
  return {
    providerSubscriptionId: String(data.id),
    status: asString(data.status) ?? "active",
    currentPeriodEnd: fromUnixSeconds(data.current_period_end),
    providerCustomerId: asString(data.customer),
  };
}

function toInvoiceRef(data: Record<string, unknown>): InvoiceRef {
  return {
    providerInvoiceId: String(data.id),
    number: asString(data.number),
    status: asString(data.status) ?? "open",
    totalCents: asInt(data.total) ?? 0,
    currency: (asString(data.currency) ?? "PHP").toUpperCase(),
    hostedUrl: asString(data.hosted_invoice_url),
    pdfUrl: asString(data.invoice_pdf),
    issuedAt: fromUnixSeconds(data.created),
    paidAt: fromUnixSeconds(record(data.status_transitions).paid_at),
  };
}

/** `Stripe-Signature: t=1234567890,v1=abc123` — `v1` may repeat; the first wins. */
export function parseStripeSignature(header: string): { timestamp: number | null; signature: string | null } {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed)) return { timestamp: null, signature: null };
      timestamp = parsed;
    } else if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return { timestamp: null, signature: null };
  return { timestamp, signature: signatures[0] as string };
}
