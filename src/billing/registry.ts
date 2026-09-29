import { Inject, Injectable } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { BillingProviderNotConfiguredError } from "../core/errors";
import { ManualBillingProvider } from "./providers/manual.provider";
import { PaddleBillingProvider } from "./providers/paddle.provider";
import { PayMongoBillingProvider } from "./providers/paymongo.provider";
import { StripeBillingProvider } from "./providers/stripe.provider";
import { XenditBillingProvider } from "./providers/xendit.provider";
import { type BillingProvider, type FetchLike, isBillingProviderName } from "./providers";

/**
 * Provider factory: name → a configured client. A hosted provider selected
 * without its secret is a 409 `billing_provider_not_configured`, raised here
 * rather than discovered mid-checkout. `fetchImpl` is injectable so tests point
 * the clients at a local stub server.
 */
@Injectable()
export class BillingProviderRegistry {
  constructor(@Inject(SETTINGS) private readonly settings: Settings) {}

  /** The deployment's configured provider. */
  current(fetchImpl?: FetchLike): BillingProvider {
    return this.build(this.settings.SYNAPSE_BILLING_PROVIDER, fetchImpl);
  }

  /** For webhook ingest: build the provider the request claims to come from. */
  build(name: string, fetchImpl?: FetchLike): BillingProvider {
    const currency = this.settings.SYNAPSE_BILLING_CURRENCY;
    const s = this.settings;
    if (!isBillingProviderName(name)) throw new BillingProviderNotConfiguredError(`Unknown billing provider '${name}'`, { provider: name });
    switch (name) {
      case "manual":
        return new ManualBillingProvider(s.SYNAPSE_MANUAL_WEBHOOK_TOKEN, currency);
      case "stripe":
        return new StripeBillingProvider({
          secretKey: require_(s.SYNAPSE_STRIPE_SECRET_KEY, "Stripe", "SYNAPSE_STRIPE_SECRET_KEY"),
          webhookSecret: s.SYNAPSE_STRIPE_WEBHOOK_SECRET,
          currency,
          fetchImpl,
        });
      case "xendit":
        return new XenditBillingProvider({
          secretKey: require_(s.SYNAPSE_XENDIT_SECRET_KEY, "Xendit", "SYNAPSE_XENDIT_SECRET_KEY"),
          webhookToken: s.SYNAPSE_XENDIT_WEBHOOK_TOKEN,
          currency,
          fetchImpl,
        });
      case "paymongo":
        return new PayMongoBillingProvider({
          secretKey: require_(s.SYNAPSE_PAYMONGO_SECRET_KEY, "PayMongo", "SYNAPSE_PAYMONGO_SECRET_KEY"),
          webhookSecret: s.SYNAPSE_PAYMONGO_WEBHOOK_SECRET,
          currency,
          fetchImpl,
        });
      case "paddle":
        return new PaddleBillingProvider({
          secretKey: require_(s.SYNAPSE_PADDLE_SECRET_KEY, "Paddle", "SYNAPSE_PADDLE_SECRET_KEY"),
          webhookSecret: s.SYNAPSE_PADDLE_WEBHOOK_SECRET,
          currency,
          fetchImpl,
        });
    }
  }
}

function require_(value: string, label: string, variable: string): string {
  if (!value) throw new BillingProviderNotConfiguredError(`${label} is selected but ${variable} is not set`);
  return value;
}
