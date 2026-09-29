/**
 * The BillingProvider seam (ADR 0004) — the abstraction that keeps the
 * framework provider-agnostic: a capability table services branch on, the
 * provider-neutral DTOs, and the interface every provider implements.
 *
 * Webhook handling is split in two on purpose: `verifyWebhook(raw)` is
 * transport security over the RAW bytes the provider signed;
 * `translateWebhook(verified)` is schema mapping. Providers with exotic
 * verification (Xendit's static token vs Stripe's HMAC) differ only in the
 * first half.
 */

export enum BillingCapability {
  HOSTED_CHECKOUT = "hosted_checkout",
  BILLING_PORTAL = "billing_portal",
  /** Provider-side recurring subscriptions: the provider owns proration and invoicing. */
  RECURRING_HOSTED = "recurring_hosted",
  /** Can push our catalog to the provider. */
  PLAN_SYNC = "plan_sync",
  WEBHOOK_SIGNED = "webhook_signed",
  /**
   * Activation may be confirmed by the tenant WITHOUT a provider callback
   * (offline/manual payment). Providers that verify payment themselves must
   * never carry this flag — otherwise POST /billing/checkout/confirm is a
   * free upgrade.
   */
  CLIENT_CONFIRM = "client_confirm",
}

export type BillingProviderName = "manual" | "stripe" | "paddle" | "xendit" | "paymongo";

export const BILLING_PROVIDER_NAMES: readonly BillingProviderName[] = ["manual", "stripe", "paddle", "xendit", "paymongo"];

/** Raw webhook material. `body` is the exact bytes the provider signed. */
export interface WebhookRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface VerifiedWebhook {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly parsed: Record<string, unknown>;
  readonly receivedAt: Date;
}

/** Canonical, provider-agnostic billing event vocabulary. */
export const BillingEventType = {
  CUSTOMER_CREATED: "customer.created",
  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_ACTIVATED: "subscription.activated",
  SUBSCRIPTION_UPDATED: "subscription.updated",
  SUBSCRIPTION_CANCELED: "subscription.canceled",
  SUBSCRIPTION_PAST_DUE: "subscription.past_due",
  SUBSCRIPTION_TRIAL_ENDED: "subscription.trial_ended",
  INVOICE_CREATED: "invoice.created",
  INVOICE_PAID: "invoice.paid",
  INVOICE_FAILED: "invoice.failed",
  CHECKOUT_COMPLETED: "checkout.completed",
  PAYMENT_FAILED: "payment.failed",
} as const;

export type BillingEventTypeName = (typeof BillingEventType)[keyof typeof BillingEventType];

export interface NormalizedBillingEvent {
  readonly eventType: BillingEventTypeName;
  readonly providerEventId: string;
  readonly occurredAt: Date;
  readonly providerCustomerId?: string | null;
  readonly providerSubscriptionId?: string | null;
  readonly providerInvoiceId?: string | null;
  readonly planKey?: string | null;
  readonly status?: string | null;
  readonly currentPeriodEnd?: Date | null;
  /** Integer minor units, end to end (ADR 0006). Never `Math.round(float * 100)` on our side. */
  readonly amountCents?: number | null;
  readonly currency?: string | null;
  readonly hostedUrl?: string | null;
  readonly raw?: Record<string, unknown>;
}

export interface BillingCustomerRef {
  readonly providerCustomerId: string;
  readonly email?: string | null;
  readonly name?: string | null;
}

/** Hosted-checkout URL, or manual instructions for off-provider flows. */
export interface CheckoutResult {
  readonly url: string | null;
  readonly provider: string;
  readonly manualInstructions?: string | null;
  readonly providerCheckoutId?: string | null;
}

export interface SubscriptionRef {
  readonly providerSubscriptionId: string;
  readonly status: string;
  readonly currentPeriodEnd?: Date | null;
  readonly providerCustomerId?: string | null;
}

export interface InvoiceRef {
  readonly providerInvoiceId: string;
  readonly number: string | null;
  readonly status: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly hostedUrl?: string | null;
  readonly pdfUrl?: string | null;
  readonly issuedAt?: Date | null;
  readonly paidAt?: Date | null;
  readonly periodStart?: Date | null;
  readonly periodEnd?: Date | null;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export interface CreateCustomerRequest {
  readonly email: string;
  readonly name?: string | null;
  readonly organizationId?: string | null;
  readonly currency: string;
}

export interface CreateCheckoutRequest {
  readonly planKey: string;
  readonly planName: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly interval: string;
  readonly providerCustomerId?: string | null;
  readonly successUrl?: string | null;
  readonly cancelUrl?: string | null;
  readonly organizationId?: string | null;
}

export interface CreateSubscriptionRequest {
  readonly planKey: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly interval: string;
  readonly providerCustomerId: string;
  readonly trialDays?: number;
}

export interface ChangePlanRequest {
  readonly planKey: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly interval: string;
}

/** Every provider implements this over plain `fetch` — no vendor SDKs. */
export interface BillingProvider {
  readonly name: BillingProviderName;
  readonly supports: ReadonlySet<BillingCapability>;

  createCustomer(req: CreateCustomerRequest): Promise<BillingCustomerRef>;
  createCheckout(req: CreateCheckoutRequest): Promise<CheckoutResult>;
  billingPortalUrl(providerCustomerId: string, returnUrl: string): Promise<string>;
  createSubscription(req: CreateSubscriptionRequest): Promise<SubscriptionRef>;
  changePlan(providerSubscriptionId: string, req: ChangePlanRequest): Promise<SubscriptionRef>;
  cancelSubscription(providerSubscriptionId: string, atPeriodEnd?: boolean): Promise<SubscriptionRef>;
  getSubscription(providerSubscriptionId: string): Promise<SubscriptionRef>;
  listInvoices(providerCustomerId: string, limit?: number): Promise<InvoiceRef[]>;
  verifyWebhook(raw: WebhookRequest): Promise<VerifiedWebhook>;
  translateWebhook(verified: VerifiedWebhook): NormalizedBillingEvent[];
  /** `PLAN_SYNC` providers only: create (or reuse) the product + price for a plan. */
  upsertProductAndPrice?(input: UpsertPlanRequest): Promise<Record<string, string>>;
}

/** One paid plan, as the catalog describes it, for `upsertProductAndPrice`. */
export interface UpsertPlanRequest {
  readonly planKey: string;
  readonly planName: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly interval: string;
}

/** Injected so tests can point a provider at a local stub HTTP server. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The capability table, declared without constructing a provider: plan-change
 * branching and the worker's renewal query need it before any credentials exist.
 */
export const PROVIDER_CAPABILITIES: Readonly<Record<BillingProviderName, ReadonlySet<BillingCapability>>> = {
  // "hosted" = our own confirmation page; CLIENT_CONFIRM = the operator
  // collects payment out of band, so the tenant's confirm is the signal.
  manual: new Set([BillingCapability.HOSTED_CHECKOUT, BillingCapability.CLIENT_CONFIRM]),
  stripe: new Set([
    BillingCapability.HOSTED_CHECKOUT,
    BillingCapability.BILLING_PORTAL,
    BillingCapability.RECURRING_HOSTED,
    BillingCapability.PLAN_SYNC,
    BillingCapability.WEBHOOK_SIGNED,
  ]),
  paddle: new Set([BillingCapability.HOSTED_CHECKOUT, BillingCapability.WEBHOOK_SIGNED]),
  xendit: new Set([BillingCapability.HOSTED_CHECKOUT, BillingCapability.WEBHOOK_SIGNED]), // token-authenticated
  paymongo: new Set([BillingCapability.HOSTED_CHECKOUT, BillingCapability.WEBHOOK_SIGNED]),
};

export function capabilitiesOf(provider: string): ReadonlySet<BillingCapability> {
  return PROVIDER_CAPABILITIES[provider as BillingProviderName] ?? new Set();
}

export function isBillingProviderName(value: string): value is BillingProviderName {
  return (BILLING_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * Providers whose recurring charges WE issue (no `recurring_hosted`). The
 * worker's renewal job bills exactly these; hosted providers renew on their
 * side and tell us through webhooks.
 */
export function locallyBilledProviderNames(): BillingProviderName[] {
  return BILLING_PROVIDER_NAMES.filter((name) => !PROVIDER_CAPABILITIES[name].has(BillingCapability.RECURRING_HOSTED));
}

/** Money for human-readable provider text; never used for arithmetic. */
export function formatMoney(cents: number, currency: string): string {
  const symbols: Record<string, string> = { PHP: "₱", USD: "$", EUR: "€" };
  const symbol = symbols[currency] ?? `${currency} `;
  return `${symbol}${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
