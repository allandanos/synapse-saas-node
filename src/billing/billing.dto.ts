import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from "class-validator";
import { PERIOD_PATTERN } from "../core/validation";
import type { InvoiceLineRow, InvoiceRow } from "./invoicing/invoices.repository";

export class CheckoutIn {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  plan_key!: string;
}

export class InvoiceDraftIn {
  /** `YYYY-MM`; omitted means the current month. An impossible month is 422, never a 500. */
  @IsOptional()
  @IsString()
  @Matches(PERIOD_PATTERN)
  period?: string | null;
}

export class PaymentRecordIn {
  /** Minor units, strictly positive: recording a zero payment is meaningless. */
  @IsInt()
  @Min(1)
  amount_cents!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reference?: string | null;
}

export interface CheckoutRead {
  url: string | null;
  provider: string;
  manual_instructions: string | null;
}

export interface PortalUrlRead {
  url: string | null;
}

export interface CheckoutConfirmRead {
  status: string;
  plan_key: string;
  provider: string;
}

export interface InvoiceRead {
  id: string;
  number: string | null;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  status: string;
  period_start: Date | null;
  period_end: Date | null;
  hosted_url: string | null;
  issued_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
}

export interface InvoiceLineRead {
  id: string;
  kind: string;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  metric: string | null;
}

export interface InvoiceDetailRead extends InvoiceRead {
  lines: InvoiceLineRead[];
}

export function toInvoiceRead(row: InvoiceRow): InvoiceRead {
  return {
    id: row.id,
    number: row.number,
    currency: row.currency,
    subtotal_cents: row.subtotal_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    status: row.status,
    period_start: row.period_start,
    period_end: row.period_end,
    hosted_url: row.hosted_url,
    issued_at: row.issued_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
  };
}

export function toInvoiceLineRead(row: InvoiceLineRow): InvoiceLineRead {
  return {
    id: row.id,
    kind: row.kind,
    description: row.description,
    quantity: row.quantity,
    unit_amount_cents: row.unit_amount_cents,
    amount_cents: row.amount_cents,
    metric: row.metric,
  };
}

export function toInvoiceDetailRead(invoice: InvoiceRow, lines: readonly InvoiceLineRow[]): InvoiceDetailRead {
  return { ...toInvoiceRead(invoice), lines: lines.map(toInvoiceLineRead) };
}
