import { Inject, Injectable, Logger } from "@nestjs/common";
import { SETTINGS, type Settings } from "../core/config";
import { Database } from "../core/db/database";
import { loadCatalog, type PlanCatalog } from "../subscriptions/catalog";
import { PlansRepository } from "../subscriptions/plans.repository";
import { BillingCapability, capabilitiesOf, type FetchLike } from "./providers";
import { BillingProviderRegistry } from "./registry";

export interface PushResult {
  /** One line per plan, in catalog order — what the CLI prints. */
  readonly lines: string[];
  readonly pushed: number;
  readonly skipped: number;
}

/**
 * Push the plan catalog to a billing provider: one product + price per PAID
 * plan, with the returned ids stored in `plans.provider_refs[<provider>]`
 * (`cli.py::_push_provider_catalog`).
 *
 * Dry-run by default — it describes the diff and needs no credentials, so it
 * is safe to run against a production catalog before deciding.
 */
@Injectable()
export class PlanCatalogPush {
  private readonly logger = new Logger(PlanCatalogPush.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly plans: PlansRepository,
    private readonly registry: BillingProviderRegistry,
  ) {}

  async push(providerName: string, options: { apply?: boolean; catalog?: PlanCatalog; fetchImpl?: FetchLike } = {}): Promise<PushResult> {
    const catalog = options.catalog ?? loadCatalog(this.settings.SYNAPSE_PLANS_FILE);
    const apply = options.apply ?? false;
    const lines: string[] = [];
    let pushed = 0;
    let skipped = 0;

    if (apply && !capabilitiesOf(providerName).has(BillingCapability.PLAN_SYNC)) {
      return { lines: [`${providerName} does not support plan sync; skipping`], pushed: 0, skipped: 0 };
    }
    // Building the provider validates its credentials once, up front.
    const built = apply ? this.registry.build(providerName, options.fetchImpl) : null;
    const provider = built?.upsertProductAndPrice ? built : null;
    if (apply && !provider) {
      return { lines: [`${providerName} does not support plan sync; skipping`], pushed: 0, skipped: 0 };
    }

    for (const plan of catalog.plans) {
      if (plan.price_cents === null || plan.price_cents === undefined) {
        skipped += 1; // custom-priced plans have nothing to push
        continue;
      }
      if (!provider) {
        lines.push(`[dry-run] ${providerName}: upsert product+price for ${plan.key} (${String(plan.price_cents)} minor units)`);
        continue;
      }
      const refs = await provider.upsertProductAndPrice?.({
        planKey: plan.key,
        planName: plan.name,
        priceCents: plan.price_cents,
        currency: plan.currency ?? catalog.defaults.currency,
        interval: plan.interval ?? catalog.defaults.interval,
      });
      if (!refs) continue;
      await this.db.transaction(async (tx) => {
        await tx.bindPlatform();
        await this.plans.setProviderRefs(tx, plan.key, providerName, refs);
      });
      lines.push(`${providerName}: ${plan.key} → ${JSON.stringify(refs)}`);
      pushed += 1;
    }
    this.logger.log(`catalog push to ${providerName}: ${String(pushed)} pushed, ${String(skipped)} skipped${apply ? "" : " (dry run)"}`);
    return { lines, pushed, skipped };
  }
}
