import { Inject, Injectable, Logger } from "@nestjs/common";
import { BillingCustomersRepository } from "../billing/billing-customers.repository";
import { renderInvoicePdf } from "../billing/invoicing/invoice-pdf";
import { InvoicesRepository } from "../billing/invoicing/invoices.repository";
import { SETTINGS, type Settings } from "../core/config";
import { Database } from "../core/db/database";
import { events } from "../core/events";
import { OrganizationsRepository } from "../tenancy/organizations.repository";
import { NOTIFIER, type Notifier } from "./notifier";

/**
 * Outbox event → at most one email. The worker calls `handle` AFTER the batch
 * is durably published, so a crash or retry cannot send the same invite or
 * invoice twice. Unknown events are ignored: email is opt-in per event type,
 * and every handler is best effort — a mail problem must never fail dispatch.
 */
@Injectable()
export class NotificationHandlers {
  private readonly logger = new Logger(NotificationHandlers.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    private readonly db: Database,
    private readonly invoices: InvoicesRepository,
    private readonly customers: BillingCustomersRepository,
    private readonly organizations: OrganizationsRepository,
  ) {}

  async handle(eventType: string, payload: Record<string, unknown>): Promise<void> {
    switch (eventType) {
      case events.MEMBER_INVITE_EMAIL:
        return this.inviteEmail(payload);
      case events.USER_PASSWORD_RESET_LINK:
        return this.passwordResetEmail(payload);
      case events.INVOICE_EMAIL:
        return this.invoiceEmail(payload);
      case events.USAGE_SOFT_LIMIT_REACHED:
        return this.softLimitEmail(payload);
      default:
        return;
    }
  }

  private webUrl(path: string): string {
    return `${this.settings.SYNAPSE_WEB_ORIGIN.replace(/\/+$/, "")}${path}`;
  }

  private async inviteEmail(payload: Record<string, unknown>): Promise<void> {
    const email = asString(payload.email);
    const token = asString(payload.invite_token);
    if (!email || !token) {
      this.logger.debug("invite email skipped: missing fields");
      return;
    }
    const organization = asString(payload.org_name) ?? "an organization";
    // The console accepts invite tokens on registration.
    const link = this.webUrl(`/register?invite=${encodeURIComponent(token)}`);
    await this.notifier.send({
      to: email,
      subject: `You've been invited to ${organization}`,
      body:
        `Someone invited you to ${organization}.\n\n` +
        `Accept your invitation by registering with this link:\n${link}\n\n` +
        "If you weren't expecting this, you can ignore this email.",
    });
  }

  private async passwordResetEmail(payload: Record<string, unknown>): Promise<void> {
    const email = asString(payload.email);
    const token = asString(payload.token);
    if (!email || !token) return;
    const link = this.webUrl(`/login?reset=${encodeURIComponent(token)}`); // the console routes to the reset form
    await this.notifier.send({
      to: email,
      subject: "Reset your password",
      body:
        "A password reset was requested for your account.\n\n" +
        `Reset it here (valid 30 minutes):\n${link}\n\n` +
        "If you didn't request this, ignore this email.",
    });
  }

  /** The PDF is re-rendered at send time, so the attachment always matches current invoice state. */
  private async invoiceEmail(payload: Record<string, unknown>): Promise<void> {
    const invoiceId = asString(payload.invoice_id);
    if (!invoiceId) {
      this.logger.debug("invoice email skipped: missing invoice_id");
      return;
    }
    const composed = await this.db.transaction(async (tx) => {
      const invoice = await this.invoices.findById(tx, invoiceId);
      if (!invoice) {
        this.logger.warn(`invoice email: invoice ${invoiceId} is missing`);
        return null;
      }
      await tx.bindTenant(invoice.organization_id);
      const lines = await this.invoices.linesFor(tx, invoice.id);
      const organization = await this.organizations.findById(tx, invoice.organization_id);
      const customer = invoice.billing_customer_id === null ? undefined : await this.customers.findById(tx, invoice.billing_customer_id);
      const recipient = await this.customers.recipient(tx, invoice.organization_id);
      return { invoice, lines, orgName: organization?.name ?? "Customer", billingEmail: customer?.email ?? null, recipient };
    });
    if (!composed) return;
    if (!composed.recipient) {
      this.logger.log(`invoice email: no recipient for invoice ${invoiceId}`);
      return;
    }
    const pdf = await renderInvoicePdf({
      invoice: composed.invoice,
      lines: composed.lines,
      orgName: composed.orgName,
      billingEmail: composed.billingEmail,
      payToInstructions: this.settings.SYNAPSE_MANUAL_PAY_TO_INSTRUCTIONS || null,
    });
    const number = composed.invoice.number ?? composed.invoice.id;
    const total = `${(composed.invoice.total_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${composed.invoice.currency}`;
    const paid = composed.invoice.status === "paid";
    await this.notifier.send({
      to: composed.recipient,
      subject: paid ? `Paid: Invoice ${number}` : `Invoice ${number}: ${total} due`,
      body: paid
        ? `Your payment for invoice ${number} (${total}) has been received. The invoice is attached for your records.`
        : `Invoice ${number} for ${total} is attached. Payment instructions are included in the PDF.`,
      attachments: [{ filename: `invoice-${number}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
  }

  /** Org-level quota warning to the billing contact. */
  private async softLimitEmail(payload: Record<string, unknown>): Promise<void> {
    const metric = asString(payload.metric);
    const organizationId = asString(payload.organization_id);
    if (!metric || !organizationId) {
      this.logger.debug("soft limit email skipped: missing organization_id/metric");
      return;
    }
    const recipient = await this.db.transaction(async (tx) => {
      await tx.bindTenant(organizationId);
      return this.customers.recipient(tx, organizationId);
    });
    if (!recipient) {
      this.logger.log(`soft limit email: no recipient for org ${organizationId}`);
      return;
    }
    await this.notifier.send({
      to: recipient,
      subject: `You're approaching your ${metric} limit`,
      body:
        `Your organization has used ${String(payload.total ?? "?")} of ${String(payload.limit ?? "?")} ${metric} for this period.\n\n` +
        `Upgrade or add capacity here: ${this.webUrl("/dashboard/billing")}`,
    });
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
