import { randomBytes } from "node:crypto";
import { WebhookSignatureInvalidError } from "../../core/errors";
import { constantTimeEquals } from "../../core/security";
import {
  BillingCapability,
  type BillingCustomerRef,
  BillingEventType,
  type BillingProvider,
  type ChangePlanRequest,
  type CheckoutResult,
  type CreateCheckoutRequest,
  type CreateCustomerRequest,
  type CreateSubscriptionRequest,
  formatMoney,
  type InvoiceRef,
  type NormalizedBillingEvent,
  PROVIDER_CAPABILITIES,
  type SubscriptionRef,
  type VerifiedWebhook,
  type WebhookRequest,
} from "../providers";

const MANUAL_TOKEN_HEADER = "x-manual-token";
const THIRTY_DAYS_MS = 30 * 86_400_000;

function token(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/**
 * Manual / enterprise billing: zero external accounts, so `docker compose up`
 * gives the whole freemium loop locally. "Checkout" is our own confirmation
 * page; renewals are advanced by the worker's recurring-billing job, which
 * issues invoices on period roll. Webhook ingest is protected by a shared
 * deployment token instead of a signature.
 */
export class ManualBillingProvider implements BillingProvider {
  readonly name = "manual" as const;
  readonly supports = PROVIDER_CAPABILITIES.manual;

  constructor(
    private readonly webhookToken: string = "",
    private readonly currency: string = "PHP",
  ) {}

  createCustomer(req: CreateCustomerRequest): Promise<BillingCustomerRef> {
    return Promise.resolve({ providerCustomerId: token("manual"), email: req.email, name: req.name ?? null });
  }

  createCheckout(req: CreateCheckoutRequest): Promise<CheckoutResult> {
    // Manual checkout renders our own confirmation page; no external URL.
    return Promise.resolve({
      url: null,
      provider: this.name,
      providerCheckoutId: token("manualco"),
      manualInstructions:
        `Confirm the ${req.planName} plan (${formatMoney(req.priceCents, req.currency)}/${req.interval}). ` +
        "No payment provider is configured; the subscription activates immediately " +
        "and invoices are recorded by the system.",
    });
  }

  billingPortalUrl(): Promise<string> {
    return Promise.reject(new Error(`${this.name} does not support billing portals`));
  }

  createSubscription(req: CreateSubscriptionRequest): Promise<SubscriptionRef> {
    return Promise.resolve({
      providerSubscriptionId: token("manualsub"),
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
    return Promise.resolve([]); // manual invoices live in our database only
  }

  verifyWebhook(raw: WebhookRequest): Promise<VerifiedWebhook> {
    const supplied = raw.headers[MANUAL_TOKEN_HEADER] ?? "";
    if (!this.webhookToken || !constantTimeEquals(supplied, this.webhookToken)) {
      throw new WebhookSignatureInvalidError("Missing or invalid manual webhook token");
    }
    const parsed = parseJsonBody(raw.body, "manual");
    return Promise.resolve({
      providerEventId: String(parsed.id ?? token("manual")),
      eventType: String(parsed.type ?? "manual.event"),
      parsed,
      receivedAt: new Date(),
    });
  }

  translateWebhook(verified: VerifiedWebhook): NormalizedBillingEvent[] {
    const mapping: Record<string, NormalizedBillingEvent["eventType"]> = {
      "manual.subscription.activated": BillingEventType.SUBSCRIPTION_ACTIVATED,
      "manual.subscription.canceled": BillingEventType.SUBSCRIPTION_CANCELED,
      "manual.invoice.paid": BillingEventType.INVOICE_PAID,
    };
    const canonical = mapping[String(verified.parsed.type ?? "")];
    if (!canonical) return [];
    const data = (verified.parsed.data ?? {}) as Record<string, unknown>;
    return [
      {
        eventType: canonical,
        providerEventId: verified.providerEventId,
        occurredAt: verified.receivedAt,
        providerSubscriptionId: asString(data.subscription_id),
        providerCustomerId: asString(data.customer_id),
        providerInvoiceId: asString(data.invoice_id),
        planKey: asString(data.plan_key),
        status: asString(data.status),
        amountCents: asInt(data.amount_cents),
        currency: asString(data.currency) ?? this.currency,
        raw: verified.parsed,
      },
    ];
  }
}

export function parseJsonBody(body: Buffer, provider: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new WebhookSignatureInvalidError(`Malformed ${provider} webhook body`);
  }
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
