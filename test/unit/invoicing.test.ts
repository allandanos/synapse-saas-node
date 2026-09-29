import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, renderInvoicePdf } from "../../src/billing/invoicing/invoice-pdf";
import { assertInvoiceTransition, INVOICE_TRANSITIONS, invoiceNumber, monthStart, periodBounds } from "../../src/billing/invoicing/invoice-numbering";
import { adjustmentLines } from "../../src/billing/invoicing/invoicing.service";
import type { InvoiceLineRow, InvoiceRow } from "../../src/billing/invoicing/invoices.repository";
import { Overage } from "../../src/entitlements/resolver";

describe("invoice state machine", () => {
  it("allows exactly the reference's transitions", () => {
    expect([...(INVOICE_TRANSITIONS.draft as Set<string>)].sort()).toEqual(["open", "void"]);
    expect([...(INVOICE_TRANSITIONS.open as Set<string>)].sort()).toEqual(["paid", "uncollectible", "void"]);
    for (const terminal of ["paid", "void", "uncollectible"] as const) expect(INVOICE_TRANSITIONS[terminal].size).toBe(0);
  });

  it("is a no-op for the current status and 422s with from/to/allowed otherwise", () => {
    expect(() => {
      assertInvoiceTransition("paid", "paid");
    }).not.toThrow();
    try {
      assertInvoiceTransition("draft", "paid");
      expect.unreachable("draft → paid must be refused");
    } catch (error) {
      expect(error).toMatchObject({ status: 422, title: "validation_failed", extras: { from: "draft", to: "paid", allowed: ["open", "void"] } });
    }
    expect(() => {
      assertInvoiceTransition("paid", "void");
    }).toThrow(/Cannot move invoice/);
  });
});

describe("numbering and periods", () => {
  it("numbers INV-YYYYMM-#### from the count of prior finals", () => {
    const march = new Date(Date.UTC(2026, 2, 15));
    expect(invoiceNumber(0, march)).toBe("INV-202603-0001");
    expect(invoiceNumber(41, march)).toBe("INV-202603-0042");
  });

  it("buckets by UTC month and spans the whole month", () => {
    expect(monthStart(new Date(Date.UTC(2026, 8, 29, 23, 30)))).toBe("2026-09-01");
    const september = periodBounds("2026-09-01");
    expect(september.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(september.end.toISOString()).toBe("2026-09-30T23:59:59.000Z");
    // February, and a leap February, are the interesting edges.
    expect(periodBounds("2026-02-01").end.toISOString()).toBe("2026-02-28T23:59:59.000Z");
    expect(periodBounds("2028-02-01").end.toISOString()).toBe("2028-02-29T23:59:59.000Z");
    expect(periodBounds("2026-12-01").end.toISOString()).toBe("2026-12-31T23:59:59.000Z");
  });
});

describe("line construction", () => {
  it("keeps every overage line self-reconciling: quantity x unit == amount", () => {
    for (const [unit, price, unitsOver] of [
      [1, 5, 7],
      [1000, 50, 4201],
      [100, 999, 100],
    ] as const) {
      const [quantity, cents] = new Overage(unit, price).bill(unitsOver);
      expect(quantity * price).toBe(cents);
      expect(quantity).toBe(Math.ceil(unitsOver / unit));
    }
    expect(new Overage(1000, 50).bill(0)).toEqual([0, 0]);
  });

  it("turns pending adjustments into credit/custom lines and drops the zeroes", () => {
    const lines = adjustmentLines([
      { kind: "proration", amount_cents: -250, description: "Downgrade credit", from_plan: "pro" },
      { kind: "proration", amount_cents: 400, description: "Upgrade charge" },
      { kind: "proration", amount_cents: 0, description: "Nothing owed" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "credit", amount_cents: -250, unit_amount_cents: -250, quantity: 1, description: "Downgrade credit" });
    expect(lines[0]?.properties).toEqual({ kind: "proration", from_plan: "pro" });
    expect(lines[1]).toMatchObject({ kind: "custom", amount_cents: 400 });
  });
});

describe("invoice PDF", () => {
  const invoice: InvoiceRow = {
    id: "0f1a9e4e-0000-4000-8000-000000000001",
    organization_id: "org",
    billing_customer_id: null,
    provider: "synapse",
    provider_invoice_id: null,
    number: "INV-202609-0001",
    currency: "PHP",
    subtotal_cents: 149_900,
    tax_cents: 0,
    total_cents: 149_900,
    status: "open",
    period_start: new Date("2026-09-01T00:00:00Z"),
    period_end: new Date("2026-09-30T23:59:59Z"),
    hosted_url: null,
    pdf_url: null,
    issued_at: new Date("2026-09-29T10:00:00Z"),
    paid_at: null,
    created_at: new Date("2026-09-29T10:00:00Z"),
  };
  const lines: InvoiceLineRow[] = [
    {
      id: "l1",
      invoice_id: invoice.id,
      organization_id: "org",
      kind: "plan",
      description: "Pro plan (monthly) — em dash and ₱ sign",
      quantity: 1,
      unit_amount_cents: 149_900,
      amount_cents: 149_900,
      metric: null,
      properties: {},
    },
    {
      id: "l2",
      invoice_id: invoice.id,
      organization_id: "org",
      kind: "overage",
      description: "api_requests overage — 4,201 units over plan (per 1,000)",
      quantity: 5,
      unit_amount_cents: 50,
      amount_cents: 250,
      metric: "api_requests",
      properties: {},
    },
  ];

  it("renders a real PDF, including for an invoice with no lines", async () => {
    const pdf = await renderInvoicePdf({ invoice, lines, orgName: "Açaí Örg", billingEmail: "billing@example.test", payToInstructions: "Bank transfer" });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
    const empty = await renderInvoicePdf({ invoice: { ...invoice, subtotal_cents: 0, total_cents: 0 }, lines: [], orgName: "Empty Org" });
    expect(empty.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("formats money with the reference's prefixes and dates in UTC", () => {
    expect(formatMoney(149_900, "PHP")).toBe("PHP 1,499.00");
    expect(formatMoney(0, "USD")).toBe("USD 0.00");
    expect(formatMoney(5, "JPY")).toBe("JPY 0.05");
    expect(formatDate(new Date("2026-09-29T23:30:00Z"))).toBe("Sep 29, 2026");
  });
});
