import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BillingEventType, type WebhookRequest } from "../../src/billing/providers";
import { ManualBillingProvider } from "../../src/billing/providers/manual.provider";
import { PaddleBillingProvider } from "../../src/billing/providers/paddle.provider";
import { PayMongoBillingProvider } from "../../src/billing/providers/paymongo.provider";
import { parseStripeSignature, StripeBillingProvider } from "../../src/billing/providers/stripe.provider";
import { majorUnits, minorUnits, XenditBillingProvider } from "../../src/billing/providers/xendit.provider";
import { flattenForm } from "../../src/billing/providers/http";
import { StubProviderServer } from "../support/stub-provider-server";

const SECRET = "whsec_test_secret";
const now = (): number => Math.floor(Date.now() / 1000);

function raw(body: string, headers: Record<string, string> = {}): WebhookRequest {
  return { headers, body: Buffer.from(body, "utf8") };
}

function dotSignature(body: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${String(timestamp)}.${body}`).digest("hex");
}

function colonSignature(body: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${String(timestamp)}:${body}`).digest("hex");
}

describe("webhook signature verification", () => {
  const stripe = new StripeBillingProvider({ secretKey: "sk_test", webhookSecret: SECRET });
  const paymongo = new PayMongoBillingProvider({ secretKey: "sk_test", webhookSecret: SECRET });
  const paddle = new PaddleBillingProvider({ secretKey: "pk_test", webhookSecret: SECRET });
  const xendit = new XenditBillingProvider({ secretKey: "sk_test", webhookToken: SECRET });
  const manual = new ManualBillingProvider(SECRET);

  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: { id: "in_1" } } });

  it("accepts a well-formed Stripe signature", async () => {
    const t = now();
    const verified = await stripe.verifyWebhook(raw(body, { "stripe-signature": `t=${String(t)},v1=${dotSignature(body, SECRET, t)}` }));
    expect(verified.providerEventId).toBe("evt_1");
    expect(verified.eventType).toBe("invoice.paid");
  });

  it("rejects a tampered body, a wrong secret, a stale timestamp and a missing header", async () => {
    const t = now();
    const good = dotSignature(body, SECRET, t);
    await expect(stripe.verifyWebhook(raw(`${body} `, { "stripe-signature": `t=${String(t)},v1=${good}` }))).rejects.toThrow(/signature mismatch/);
    await expect(
      stripe.verifyWebhook(raw(body, { "stripe-signature": `t=${String(t)},v1=${dotSignature(body, "other", t)}` })),
    ).rejects.toThrow(/signature mismatch/);
    const stale = t - 3600;
    await expect(stripe.verifyWebhook(raw(body, { "stripe-signature": `t=${String(stale)},v1=${dotSignature(body, SECRET, stale)}` }))).rejects.toThrow(
      /tolerance/,
    );
    await expect(stripe.verifyWebhook(raw(body))).rejects.toThrow(/Malformed Stripe-Signature/);
  });

  it("parses repeated v1 parts and refuses a non-numeric timestamp", () => {
    expect(parseStripeSignature("t=12,v1=aa,v1=bb")).toEqual({ timestamp: 12, signature: "aa" });
    expect(parseStripeSignature("t=abc,v1=aa")).toEqual({ timestamp: null, signature: null });
    expect(parseStripeSignature("v1=aa")).toEqual({ timestamp: null, signature: null });
  });

  it("verifies PayMongo with the same t/v1 scheme", async () => {
    const payload = JSON.stringify({ id: "evt_pm", type: "payment.paid", data: { attributes: { amount: 5000 } } });
    const t = now();
    const verified = await paymongo.verifyWebhook(raw(payload, { "paymongo-signature": `t=${String(t)},v1=${dotSignature(payload, SECRET, t)}` }));
    expect(verified.eventType).toBe("payment.paid");
    await expect(paymongo.verifyWebhook(raw(payload, { "paymongo-signature": `t=${String(t)},v1=deadbeef` }))).rejects.toThrow(/signature mismatch/);
  });

  it("verifies Paddle over '{ts}:body' and tolerates a comma separator", async () => {
    const payload = JSON.stringify({ event_id: "evt_pd", event_type: "subscription.activated", data: { id: "sub_1" } });
    const t = now();
    const signature = colonSignature(payload, SECRET, t);
    await expect(paddle.verifyWebhook(raw(payload, { "paddle-signature": `ts=${String(t)};h1=${signature}` }))).resolves.toMatchObject({
      providerEventId: "evt_pd",
    });
    await expect(paddle.verifyWebhook(raw(payload, { "paddle-signature": `ts=${String(t)},h1=${signature}` }))).resolves.toMatchObject({
      providerEventId: "evt_pd",
    });
    // Stripe's dot scheme must not verify a Paddle notification.
    await expect(paddle.verifyWebhook(raw(payload, { "paddle-signature": `ts=${String(t)};h1=${dotSignature(payload, SECRET, t)}` }))).rejects.toThrow(
      /signature mismatch/,
    );
  });

  it("compares Xendit's and the manual provider's static tokens in constant time", async () => {
    const payload = JSON.stringify({ id: "inv_1", status: "PAID", amount: 1499, currency: "PHP" });
    await expect(xendit.verifyWebhook(raw(payload, { "x-callback-token": SECRET }))).resolves.toMatchObject({ eventType: "PAID" });
    await expect(xendit.verifyWebhook(raw(payload, { "x-callback-token": "nope" }))).rejects.toThrow(/X-Callback-Token/);
    await expect(xendit.verifyWebhook(raw(payload))).rejects.toThrow(/X-Callback-Token/);

    const manualBody = JSON.stringify({ id: "mev_1", type: "manual.invoice.paid", data: {} });
    await expect(manual.verifyWebhook(raw(manualBody, { "x-manual-token": SECRET }))).resolves.toMatchObject({ providerEventId: "mev_1" });
    await expect(manual.verifyWebhook(raw(manualBody, { "x-manual-token": "" }))).rejects.toThrow(/manual webhook token/);
  });

  it("refuses an unconfigured secret rather than accepting anything", async () => {
    const unconfigured = new ManualBillingProvider("");
    await expect(unconfigured.verifyWebhook(raw("{}", { "x-manual-token": "" }))).rejects.toThrow(/manual webhook token/);
    const paddleNoSecret = new PaddleBillingProvider({ secretKey: "pk", webhookSecret: "" });
    await expect(paddleNoSecret.verifyWebhook(raw("{}", { "paddle-signature": "ts=1;h1=aa" }))).rejects.toThrow(/secret not configured/);
  });

  it("rejects a malformed body even with a valid signature", async () => {
    const t = now();
    await expect(stripe.verifyWebhook(raw("not-json", { "stripe-signature": `t=${String(t)},v1=${dotSignature("not-json", SECRET, t)}` }))).rejects.toThrow(
      /Malformed Stripe webhook body/,
    );
  });
});

describe("translate_webhook maps each provider onto the canonical vocabulary", () => {
  it("Stripe: invoice.paid, subscription.updated and an ignored type", () => {
    const stripe = new StripeBillingProvider({ secretKey: "sk", webhookSecret: SECRET });
    const paid = stripe.translateWebhook({
      providerEventId: "evt_1",
      eventType: "invoice.paid",
      receivedAt: new Date(),
      parsed: { created: 1_700_000_000, data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_1", amount_paid: 14_900, currency: "php" } } },
    });
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      eventType: BillingEventType.INVOICE_PAID,
      providerInvoiceId: "in_1",
      providerSubscriptionId: "sub_1",
      amountCents: 14_900,
      currency: "PHP",
    });

    const updated = stripe.translateWebhook({
      providerEventId: "evt_2",
      eventType: "customer.subscription.updated",
      receivedAt: new Date(),
      parsed: { data: { object: { id: "sub_1", customer: "cus_1", status: "past_due", current_period_end: 1_700_000_000, metadata: { plan_key: "pro" } } } },
    });
    expect(updated[0]).toMatchObject({ eventType: BillingEventType.SUBSCRIPTION_UPDATED, providerSubscriptionId: "sub_1", status: "past_due", planKey: "pro" });
    expect(stripe.translateWebhook({ providerEventId: "x", eventType: "customer.created", receivedAt: new Date(), parsed: {} })).toEqual([]);
  });

  it("Paddle, Xendit, PayMongo and manual", () => {
    const paddle = new PaddleBillingProvider({ secretKey: "pk", webhookSecret: SECRET });
    expect(
      paddle.translateWebhook({
        providerEventId: "e",
        eventType: "transaction.completed",
        receivedAt: new Date(),
        parsed: { data: { id: "txn_1", subscription_id: "sub_1", customer_id: "ctm_1", custom_data: { plan_key: "pro" }, totals: { total: "14900" } } },
      })[0],
    ).toMatchObject({ eventType: BillingEventType.CHECKOUT_COMPLETED, providerSubscriptionId: "sub_1", planKey: "pro", amountCents: 14_900 });

    const xendit = new XenditBillingProvider({ secretKey: "sk", webhookToken: SECRET });
    expect(
      xendit.translateWebhook({ providerEventId: "e", eventType: "PAID", receivedAt: new Date(), parsed: { id: "inv_1", amount: 1499, currency: "PHP" } })[0],
    ).toMatchObject({ eventType: BillingEventType.INVOICE_PAID, providerInvoiceId: "inv_1", amountCents: 149_900 });
    expect(xendit.translateWebhook({ providerEventId: "e", eventType: "PENDING", receivedAt: new Date(), parsed: {} })).toEqual([]);

    const paymongo = new PayMongoBillingProvider({ secretKey: "sk", webhookSecret: SECRET });
    expect(
      paymongo.translateWebhook({
        providerEventId: "e",
        eventType: "checkout_session.completed",
        receivedAt: new Date(),
        parsed: { data: { attributes: { line_items: [{ amount: 14_900 }], metadata: { plan_key: "pro" } } } },
      })[0],
    ).toMatchObject({ eventType: BillingEventType.CHECKOUT_COMPLETED, amountCents: 14_900, planKey: "pro" });

    const manual = new ManualBillingProvider(SECRET);
    expect(
      manual.translateWebhook({
        providerEventId: "e",
        eventType: "manual.subscription.activated",
        receivedAt: new Date(),
        parsed: { type: "manual.subscription.activated", data: { subscription_id: "s", plan_key: "pro" } },
      })[0],
    ).toMatchObject({ eventType: BillingEventType.SUBSCRIPTION_ACTIVATED, planKey: "pro" });
    expect(manual.translateWebhook({ providerEventId: "e", eventType: "manual.other", receivedAt: new Date(), parsed: { type: "manual.other" } })).toEqual([]);
  });
});

describe("money never round-trips through a float (ADR 0006)", () => {
  it("parses Xendit's major units exactly", () => {
    // Math.round(0.29 * 100) is 29, but Math.trunc(0.29 * 100) is 28 — the
    // reference truncates, so decimal-string parsing is the only safe route.
    expect(minorUnits("0.29")).toBe(29);
    expect(minorUnits("1499.00")).toBe(149_900);
    expect(minorUnits(1499)).toBe(149_900);
    expect(minorUnits("-12.345")).toBe(-1235);
    expect(minorUnits("nope")).toBeNull();
  });

  it("renders integer cents back as an exact decimal string", () => {
    expect(majorUnits(149_900)).toBe("1499.00");
    expect(majorUnits(29)).toBe("0.29");
    expect(majorUnits(0)).toBe("0.00");
  });
});

describe("provider clients over a local stub server", () => {
  it("Stripe posts form-encoded bodies and surfaces API errors as 502", async () => {
    const stub = new StubProviderServer({
      "POST /customers": { json: { id: "cus_123" } },
      "POST /checkout/sessions": { json: { id: "cs_1", url: "https://checkout.example/cs_1" } },
      "POST /billing_portal/sessions": { json: { url: "https://portal.example/p_1" } },
      "POST /subscriptions/sub_dead": { status: 402, json: { error: { message: "card declined" } } },
    });
    const base = await stub.start();
    try {
      const stripe = new StripeBillingProvider({ secretKey: "sk_live_x", webhookSecret: SECRET, apiBase: base });
      const customer = await stripe.createCustomer({ email: "a@b.test", name: "A", organizationId: "org-1", currency: "PHP" });
      expect(customer.providerCustomerId).toBe("cus_123");

      const checkout = await stripe.createCheckout({
        planKey: "pro",
        planName: "Pro",
        priceCents: 149_900,
        currency: "PHP",
        interval: "month",
        providerCustomerId: "cus_123",
        successUrl: "https://app.test/ok",
      });
      expect(checkout.url).toBe("https://checkout.example/cs_1");
      const call = stub.calls.find((entry) => entry.url === "/checkout/sessions");
      expect(call?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(call?.headers.authorization).toBe(`Basic ${Buffer.from("sk_live_x:", "utf8").toString("base64")}`);
      // Minor units on the wire, and the currency lowercased the way Stripe wants it.
      expect(call?.body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=149900");
      expect(call?.body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=php");

      expect(await stripe.billingPortalUrl("cus_123", "https://app.test/back")).toBe("https://portal.example/p_1");
      await expect(stripe.cancelSubscription("sub_dead")).rejects.toMatchObject({ status: 502, title: "billing_provider_error" });
    } finally {
      await stub.stop();
    }
  });

  it("PayMongo sends centavos in its JSON envelope", async () => {
    const stub = new StubProviderServer({
      "POST /checkout_sessions": { json: { data: { id: "cs_pm", attributes: { checkout_url: "https://pay.example/x" } } } },
    });
    const base = await stub.start();
    try {
      const paymongo = new PayMongoBillingProvider({ secretKey: "sk", webhookSecret: SECRET, apiBase: base });
      const checkout = await paymongo.createCheckout({ planKey: "pro", planName: "Pro", priceCents: 149_900, currency: "PHP", interval: "month" });
      expect(checkout.url).toBe("https://pay.example/x");
      expect(JSON.parse(stub.calls[0]?.body ?? "{}")).toMatchObject({ data: { attributes: { line_items: [{ amount: 149_900 }] } } });
    } finally {
      await stub.stop();
    }
  });
});

describe("form flattening", () => {
  it("nests like Stripe and drops nullish values", () => {
    expect(flattenForm({ a: 1, b: { c: "x", d: null }, e: true, f: undefined })).toEqual({ a: "1", "b[c]": "x", e: "true" });
  });
});
