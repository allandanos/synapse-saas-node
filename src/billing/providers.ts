/**
 * Billing provider capability table (ADR 0004) — what each provider can do,
 * so services check capabilities rather than provider names. The provider
 * clients themselves (checkout, webhooks, hosted plan changes) arrive with
 * milestone 4; this table is what the plan-change branching needs today.
 */
export enum BillingCapability {
  HOSTED_CHECKOUT = "hosted_checkout",
  BILLING_PORTAL = "billing_portal",
  /** Provider-side recurring subscriptions: the provider owns proration and invoicing. */
  RECURRING_HOSTED = "recurring_hosted",
  /** Can push our catalog to the provider. */
  PLAN_SYNC = "plan_sync",
  WEBHOOK_SIGNED = "webhook_signed",
  /** Activation may be confirmed by the tenant WITHOUT a provider callback (offline/manual payment). */
  CLIENT_CONFIRM = "client_confirm",
}

export type BillingProviderName = "manual" | "stripe" | "paddle" | "xendit" | "paymongo";

export const PROVIDER_CAPABILITIES: Readonly<Record<BillingProviderName, ReadonlySet<BillingCapability>>> = {
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

/** Providers whose recurring charges WE issue (no `recurring_hosted` capability). */
export function locallyBilledProviderNames(): BillingProviderName[] {
  return (Object.keys(PROVIDER_CAPABILITIES) as BillingProviderName[]).filter((name) => !PROVIDER_CAPABILITIES[name].has(BillingCapability.RECURRING_HOSTED));
}
