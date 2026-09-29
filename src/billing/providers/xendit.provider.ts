import { randomBytes } from "node:crypto";
import { WebhookSignatureInvalidError } from "../../core/errors";
import { constantTimeEquals } from "../../core/security";
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
import { asString, parseJsonBody } from "./manual.provider";

export const XENDIT_API_BASE = "https://api.xendit.co";
const THIRTY_DAYS_MS = 30 * 86_400_000;

export interface XenditOptions {
  readonly secretKey: string;
  readonly webhookToken: string;
  readonly apiBase?: string;
  readonly currency?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * Xendit (PH) — invoice-cycle billing. Its recurring coverage works off
 * scheduled invoices rather than a Stripe-style subscription object, so the
 * capability set reports the difference and the worker's renewal job fills the
 * gap. Webhooks are authenticated with a static `X-Callback-Token` compared in
 * constant time.
 */
export class XenditBillingProvider implements BillingProvider {
  readonly name = "xendit" as const;
  readonly supports = PROVIDER_CAPABILITIES.xendit;

  private readonly http: ProviderHttp;
  private readonly webhookToken: string;
  private readonly currency: string;

  constructor(options: XenditOptions) {
    this.webhookToken = options.webhookToken;
    this.currency = options.currency ?? "PHP";
    this.http = new ProviderHttp({
      fetchImpl: options.fetchImpl ?? fetch,
      baseUrl: options.apiBase ?? XENDIT_API_BASE,
      provider: this.name,
      authHeader: basicAuth(options.secretKey),
    });
  }

  async createCustomer(req: CreateCustomerRequest): Promise<BillingCustomerRef> {
    const result = await this.http.json("POST", "/customers", {
      reference_id: req.organizationId ?? randomBytes(8).toString("hex"),
      email: req.email,
      given_names: req.name ?? null,
    });
    return { providerCustomerId: String(result.id), email: req.email, name: req.name ?? null };
  }

  async createCheckout(req: CreateCheckoutRequest): Promise<CheckoutResult> {
    const result = await this.http.json("POST", "/invoices", {
      external_id: `synapse_${req.planKey}_${randomBytes(4).toString("hex")}`,
      amount: Number(majorUnits(req.priceCents)), // Xendit's API takes major units
      currency: req.currency,
      description: `${req.planName} (${req.interval}ly)`,
      payer_email: null,
      success_redirect_url: req.successUrl ?? null,
      failure_redirect_url: req.cancelUrl ?? null,
    });
    return { url: asString(result.invoice_url), provider: this.name, providerCheckoutId: asString(result.id) };
  }

  billingPortalUrl(): Promise<string> {
    return Promise.reject(new Error(`${this.name} does not support billing portals`));
  }

  createSubscription(req: CreateSubscriptionRequest): Promise<SubscriptionRef> {
    // Xendit recurring = a scheduled invoice cycle; the framework's renewal job owns it.
    return Promise.resolve({
      providerSubscriptionId: `xenditsub_${randomBytes(8).toString("hex")}`,
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

  async listInvoices(_providerCustomerId: string, limit = 20): Promise<InvoiceRef[]> {
    const result = await this.http.json("GET", `/v2/invoices?limit=${String(limit)}`);
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map((item) => this.toInvoiceRef(record(item)));
  }

  verifyWebhook(raw: WebhookRequest): Promise<VerifiedWebhook> {
    const supplied = raw.headers["x-callback-token"] ?? "";
    if (!this.webhookToken || !constantTimeEquals(supplied, this.webhookToken)) {
      throw new WebhookSignatureInvalidError("Missing or invalid X-Callback-Token");
    }
    const parsed = parseJsonBody(raw.body, "Xendit");
    return Promise.resolve({
      providerEventId: String(parsed.id ?? `xendit_${randomBytes(8).toString("hex")}`),
      eventType: String(parsed.status ?? ""),
      parsed,
      receivedAt: new Date(),
    });
  }

  translateWebhook(verified: VerifiedWebhook): NormalizedBillingEvent[] {
    const typeMap: Record<string, NormalizedBillingEvent["eventType"]> = {
      PAID: BillingEventType.INVOICE_PAID,
      EXPIRED: BillingEventType.INVOICE_FAILED,
    };
    const canonical = typeMap[verified.eventType];
    if (!canonical) return [];
    const data = verified.parsed;
    const created = data.created;
    let occurredAt = verified.receivedAt;
    if (typeof created === "string" && /^\d{10,}$/.test(created.replace(/-/g, ""))) {
      occurredAt = new Date(Number.parseInt(created.replace(/-/g, "").slice(0, 10), 10) * 1000);
    }
    return [
      {
        eventType: canonical,
        providerEventId: verified.providerEventId,
        occurredAt,
        providerInvoiceId: asString(data.id),
        providerCustomerId: asString(data.customer_id),
        amountCents: minorUnits(data.amount),
        currency: asString(data.currency) ?? this.currency,
        hostedUrl: asString(data.invoice_url),
        raw: verified.parsed,
      },
    ];
  }

  private toInvoiceRef(data: Record<string, unknown>): InvoiceRef {
    return {
      providerInvoiceId: String(data.id ?? ""),
      number: asString(data.external_id),
      status: data.status === "PAID" ? "paid" : "open",
      totalCents: minorUnits(data.amount) ?? 0,
      currency: asString(data.currency) ?? this.currency,
      hostedUrl: asString(data.invoice_url),
    };
  }
}

/** Integer cents → the exact major-unit decimal string Xendit's API expects. */
export function majorUnits(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(cents));
  return `${sign}${String(Math.floor(absolute / 100))}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * Xendit reports major units. Parsed as a decimal STRING, never
 * `Math.round(float * 100)`: `0.29 * 100` is 28.999… in binary floating point
 * and truncating it loses a centavo (ADR 0006 — money is integer minor units).
 */
export function minorUnits(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? decimalToMinor(value.toFixed(6)) : null;
  if (typeof value !== "string") return null;
  return decimalToMinor(value.trim());
}

function decimalToMinor(text: string): number | null {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const cents = Number.parseInt(`${whole as string}${(fraction + "00").slice(0, 2)}`, 10);
  const remainder = fraction.slice(2).replace(/0+$/, "");
  const rounded = remainder !== "" && Number.parseInt(remainder[0] as string, 10) >= 5 ? cents + 1 : cents;
  return sign === "-" ? -rounded : rounded;
}
