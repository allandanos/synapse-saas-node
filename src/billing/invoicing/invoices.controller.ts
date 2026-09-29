import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, StreamableFile, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { PermissionsGuard } from "../../authorization/permissions.guard";
import { RequirePermission } from "../../authorization/require-permission.decorator";
import { SETTINGS, type Settings } from "../../core/config";
import { Database, type Tx } from "../../core/db/database";
import { PageQuery, sliceInMemory, TOTAL_COUNT_HEADER } from "../../core/pagination";
import { RequestContext } from "../../core/request-context";
import { UuidPipe } from "../../core/validation";
import { PlatformAdminGuard } from "../../tenancy/platform-admin.guard";
import { TenantGuard } from "../../tenancy/tenant.guard";
import { BillingCustomersRepository } from "../billing-customers.repository";
import { type InvoiceDetailRead, InvoiceDraftIn, type InvoiceRead, PaymentRecordIn, toInvoiceDetailRead, toInvoiceRead } from "../billing.dto";
import { renderInvoicePdf } from "./invoice-pdf";
import { InvoicesRepository } from "./invoices.repository";
import { InvoicingService } from "./invoicing.service";
import { InvoiceNotFoundError } from "../../core/errors";
import { OrganizationsRepository } from "../../tenancy/organizations.repository";

/** Framework-native invoicing: the tenant's own draft → finalize → read → PDF. */
@Controller("v1/billing")
@UseGuards(TenantGuard, PermissionsGuard)
export class InvoicesController {
  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    private readonly db: Database,
    private readonly invoicing: InvoicingService,
    private readonly invoices: InvoicesRepository,
    private readonly customers: BillingCustomersRepository,
    private readonly organizations: OrganizationsRepository,
    private readonly context: RequestContext,
  ) {}

  /** Plain array body + `X-Total-Count`, like every other list route. */
  @Get("invoices")
  @RequirePermission("billing:read")
  async list(@Query() page: PageQuery, @Res({ passthrough: true }) res: Response): Promise<InvoiceRead[]> {
    const organizationId = this.context.requireTenant().organizationId;
    const rows = await this.db.transaction((tx) => this.invoicing.listForOrganization(tx, organizationId));
    const { items, total } = sliceInMemory(rows, page);
    res.setHeader(TOTAL_COUNT_HEADER, String(total));
    return items.map(toInvoiceRead);
  }

  /** Generate (or return the existing) draft for the period: plan + overage + adjustments. */
  @Post("invoices/draft")
  @HttpCode(201)
  @RequirePermission("billing:manage")
  draft(@Body() body: InvoiceDraftIn): Promise<InvoiceDetailRead> {
    const organizationId = this.context.requireTenant().organizationId;
    const period = body.period ? `${body.period}-01` : null;
    return this.db.transaction(async (tx) => {
      const invoice = await this.invoicing.draftForOrganization(tx, organizationId, { period });
      return toInvoiceDetailRead(invoice, await this.invoices.linesFor(tx, invoice.id));
    });
  }

  /** Assign a number, lock the amounts, move to open. The outbox carries the email + webhook. */
  @Post("invoices/:invoiceId/finalize")
  @HttpCode(200)
  @RequirePermission("billing:manage")
  finalize(@Param("invoiceId", UuidPipe) invoiceId: string): Promise<InvoiceDetailRead> {
    const organizationId = this.context.requireTenant().organizationId;
    return this.db.transaction(async (tx) => {
      const invoice = await this.invoicing.finalize(tx, invoiceId, organizationId);
      return toInvoiceDetailRead(invoice, await this.invoices.linesFor(tx, invoice.id));
    });
  }

  /** The framework-rendered PDF. `attachment` so a browser saves rather than renders it. */
  @Get("invoices/:invoiceId/pdf")
  @RequirePermission("billing:read")
  async pdf(@Param("invoiceId", UuidPipe) invoiceId: string): Promise<StreamableFile> {
    const organizationId = this.context.requireTenant().organizationId;
    const rendered = await this.db.transaction(async (tx) => {
      const invoice = await this.invoicing.get(tx, invoiceId, organizationId);
      const lines = await this.invoices.linesFor(tx, invoice.id);
      const organization = await this.organizations.findById(tx, organizationId);
      const customer = invoice.billing_customer_id === null ? undefined : await this.customers.findById(tx, invoice.billing_customer_id);
      return { invoice, lines, orgName: organization?.name ?? "Unknown Organization", billingEmail: customer?.email ?? null };
    });
    const pdf = await renderInvoicePdf({ ...rendered, payToInstructions: this.settings.SYNAPSE_MANUAL_PAY_TO_INSTRUCTIONS || null });
    return new StreamableFile(pdf, {
      type: "application/pdf",
      disposition: `attachment; filename="invoice-${rendered.invoice.number ?? rendered.invoice.id}.pdf"`,
      length: pdf.length,
    });
  }

  @Get("invoices/:invoiceId")
  @RequirePermission("billing:read")
  detail(@Param("invoiceId", UuidPipe) invoiceId: string): Promise<InvoiceDetailRead> {
    const organizationId = this.context.requireTenant().organizationId;
    return this.db.transaction(async (tx) => {
      const invoice = await this.invoicing.get(tx, invoiceId, organizationId);
      return toInvoiceDetailRead(invoice, await this.invoices.linesFor(tx, invoice.id));
    });
  }
}

/**
 * Operator-only money movements (ADR 0008). Recording a payment or voiding an
 * invoice is the OPERATOR's statement about money that changed hands; a tenant
 * must never mark its own invoice paid, and the surface is invisible to it
 * (404). The org is derived from the invoice, not from a tenant header.
 */
@Controller("v1/billing/admin/invoices")
@UseGuards(PlatformAdminGuard)
export class AdminInvoicesController {
  constructor(
    private readonly db: Database,
    private readonly invoicing: InvoicingService,
    private readonly invoices: InvoicesRepository,
  ) {}

  /** Record an external payment (bank transfer, cheque, cash) against an open invoice. */
  @Post(":invoiceId/pay")
  @HttpCode(200)
  pay(@Param("invoiceId", UuidPipe) invoiceId: string, @Body() body: PaymentRecordIn): Promise<InvoiceDetailRead> {
    return this.db.transaction(async (tx) => {
      const organizationId = await this.requireOrganization(tx, invoiceId);
      const invoice = await this.invoicing.recordPayment(tx, invoiceId, organizationId, { amountCents: body.amount_cents, reference: body.reference ?? null });
      return toInvoiceDetailRead(invoice, await this.invoices.linesFor(tx, invoice.id));
    });
  }

  @Post(":invoiceId/void")
  @HttpCode(200)
  void(@Param("invoiceId", UuidPipe) invoiceId: string): Promise<InvoiceDetailRead> {
    return this.db.transaction(async (tx) => {
      const organizationId = await this.requireOrganization(tx, invoiceId);
      const invoice = await this.invoicing.void(tx, invoiceId, organizationId);
      return toInvoiceDetailRead(invoice, await this.invoices.linesFor(tx, invoice.id));
    });
  }

  private async requireOrganization(tx: Tx, invoiceId: string): Promise<string> {
    const organizationId = await this.invoices.organizationOf(tx, invoiceId);
    if (organizationId === undefined) throw new InvoiceNotFoundError("Invoice not found", { invoice_id: invoiceId });
    return organizationId;
  }
}
