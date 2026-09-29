import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { PermissionsGuard } from "../authorization/permissions.guard";
import { RequirePermission } from "../authorization/require-permission.decorator";
import { Database } from "../core/db/database";
import { RequestContext } from "../core/request-context";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { TenantGuard } from "../tenancy/tenant.guard";
import { BillingService } from "./billing.service";
import { type CheckoutConfirmRead, CheckoutIn, type CheckoutRead, type PortalUrlRead } from "./billing.dto";

/** Checkout, the offline-payment confirmation, and the provider's self-service portal. */
@Controller("v1/billing")
@UseGuards(TenantGuard, PermissionsGuard)
@RequirePermission("billing:manage")
export class BillingController {
  constructor(
    private readonly db: Database,
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionsService,
    private readonly context: RequestContext,
  ) {}

  @Post("checkout")
  @HttpCode(200)
  startCheckout(@Body() body: CheckoutIn): Promise<CheckoutRead> {
    const organizationId = this.context.requireTenant().organizationId;
    const contact = this.billing.actingContact();
    return this.db.transaction(async (tx) => {
      const organization = await this.billing.requireOrganization(tx, organizationId);
      const plan = await this.subscriptions.planByKey(tx, body.plan_key);
      const { result } = await this.billing.startCheckout(
        tx,
        organization,
        plan,
        {
          successUrl: this.billing.webUrl("/dashboard/billing?checkout=success"),
          cancelUrl: this.billing.webUrl("/dashboard/billing?checkout=cancelled"),
        },
        contact,
      );
      return { url: result.url, provider: result.provider, manual_instructions: result.manualInstructions ?? null };
    });
  }

  /**
   * Offline-payment flow: the tenant confirms, the operator collects out of
   * band. 409 `checkout_confirm_not_allowed` on any provider that verifies
   * payment itself — those activate from the provider webhook only.
   */
  @Post("checkout/confirm")
  @HttpCode(200)
  confirmCheckout(@Body() body: CheckoutIn): Promise<CheckoutConfirmRead> {
    const organizationId = this.context.requireTenant().organizationId;
    const contact = this.billing.actingContact();
    return this.db.transaction(async (tx) => {
      const organization = await this.billing.requireOrganization(tx, organizationId);
      const plan = await this.subscriptions.planByKey(tx, body.plan_key);
      const { subscription } = await this.billing.completeCheckout(tx, organization, plan, { contact, source: "client_confirm" });
      return { status: subscription.status, plan_key: plan.key, provider: this.billing.providerName };
    });
  }

  /** `{url}`; null when the provider has no portal or the org has no provider customer. */
  @Get("portal-url")
  portalUrl(): Promise<PortalUrlRead> {
    const organizationId = this.context.requireTenant().organizationId;
    return this.db.transaction(async (tx) => {
      const organization = await this.billing.requireOrganization(tx, organizationId);
      return { url: await this.billing.billingPortalUrl(tx, organization, this.billing.webUrl("/dashboard/billing")) };
    });
  }
}
