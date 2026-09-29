import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BillingWebhooksService } from "../../src/billing/webhooks/billing-webhooks.service";
import { InvalidRequestError } from "../../src/core/errors";
import { events } from "../../src/core/events";
import { verifySignature } from "../../src/core/security";
import { NOTIFIER, type Message } from "../../src/notifications/notifier";
import { fernetEncrypt } from "../../src/webhooks/fernet";
import { JobsService } from "../../src/worker/jobs.service";
import { type Harness, makeTenant, platformHeaders, startHarness, stopHarness, TEST_DB, type TenantFixture } from "./harness";

const describeDb = TEST_DB ? describe : describe.skip;

/** An in-process HTTP endpoint that records what the worker delivered to it. */
class CaptureEndpoint {
  private server?: Server;
  readonly received: { body: string; signature: string }[] = [];
  status = 200;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.received.push({ body: Buffer.concat(chunks).toString("utf8"), signature: String(request.headers["x-synapse-signature"] ?? "") });
        response.writeHead(this.status).end("ok");
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        resolve();
      });
    });
  }
}

describeDb("milestone 4 billing + worker (real Postgres)", () => {
  let h: Harness;
  let platform: { Authorization: string };
  let jobs: JobsService;
  const sent: Message[] = [];

  beforeAll(async () => {
    process.env.SYNAPSE_MANUAL_WEBHOOK_TOKEN = "manual-token-for-tests";
    process.env.SYNAPSE_MANUAL_PAY_TO_INSTRUCTIONS = "Bank transfer to Synapse Ltd, account 1234";
    h = await startHarness();
    // Capture email instead of sending it: the notifier is the transport seam.
    const notifier = h.app.get<{ send: (message: Message) => Promise<void> }>(NOTIFIER);
    notifier.send = (message) => {
      sent.push(message);
      return Promise.resolve();
    };
    platform = await platformHeaders(h);
    jobs = h.app.get(JobsService);
  });

  afterAll(async () => {
    await stopHarness(h);
  });

  const paidPlanKey = async (tenant: TenantFixture): Promise<string> => {
    const plans = await h.http.get("/v1/plans").set(tenant.headers);
    const paid = (plans.body as { key: string; price_cents: number }[]).find((plan) => plan.price_cents > 0);
    expect(paid, "the catalog must ship a paid plan").toBeTruthy();
    return (paid as { key: string }).key;
  };

  it("manual checkout → confirm → draft → finalize → pdf → pay, with the plan line priced from the snapshot", async () => {
    const tenant = await makeTenant(h, "billing");
    const planKey = await paidPlanKey(tenant);

    const checkout = await h.http.post("/v1/billing/checkout").set(tenant.headers).send({ plan_key: planKey });
    expect(checkout.status, checkout.text).toBe(200);
    expect(checkout.body).toMatchObject({ url: null, provider: "manual" });
    expect(checkout.body.manual_instructions).toContain("Confirm the");
    // The customer row exists exactly once, whatever the checkout is repeated.
    await h.http.post("/v1/billing/checkout").set(tenant.headers).send({ plan_key: planKey });
    const customers = await h.pool.query("SELECT provider, provider_customer_id FROM billing_customers WHERE organization_id = $1", [tenant.orgId]);
    expect(customers.rowCount).toBe(1);
    expect(customers.rows[0].provider).toBe("manual");

    const confirm = await h.http.post("/v1/billing/checkout/confirm").set(tenant.headers).send({ plan_key: planKey });
    expect(confirm.status, confirm.text).toBe(200);
    expect(confirm.body).toMatchObject({ status: "active", plan_key: planKey, provider: "manual" });

    const draft = await h.http.post("/v1/billing/invoices/draft").set(tenant.headers).send({});
    expect(draft.status, draft.text).toBe(201);
    expect(draft.body.status).toBe("draft");
    const planLine = (draft.body.lines as { kind: string; amount_cents: number; quantity: number; unit_amount_cents: number }[]).find(
      (line) => line.kind === "plan",
    );
    expect(planLine).toBeTruthy();
    expect((planLine?.quantity ?? 0) * (planLine?.unit_amount_cents ?? 0)).toBe(planLine?.amount_cents);
    expect(draft.body.total_cents).toBe(planLine?.amount_cents);

    // Idempotent per (org, period): a second draft returns the same invoice.
    const again = await h.http.post("/v1/billing/invoices/draft").set(tenant.headers).send({});
    expect(again.body.id).toBe(draft.body.id);

    const finalized = await h.http.post(`/v1/billing/invoices/${draft.body.id}/finalize`).set(tenant.headers).send();
    expect(finalized.status, finalized.text).toBe(200);
    expect(finalized.body.status).toBe("open");
    expect(finalized.body.number).toMatch(/^INV-\d{6}-\d{4}$/);
    // `open → open` is the reference's idempotent re-assertion, so finalizing
    // twice succeeds and re-stamps the number; `draft → paid` is what the
    // state machine refuses, with the allowed set in the problem document.
    expect((await h.http.post(`/v1/billing/invoices/${draft.body.id}/finalize`).set(tenant.headers).send()).status).toBe(200);

    const pdf = await h.http.get(`/v1/billing/invoices/${draft.body.id}/pdf`).set(tenant.headers).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(pdf.headers["content-disposition"]).toContain("attachment");

    // Money movement is operator-only; the tenant cannot even see the route.
    const tenantPay = await h.http.post(`/v1/billing/admin/invoices/${draft.body.id}/pay`).set(tenant.headers).send({ amount_cents: 1 });
    expect(tenantPay.status).toBe(404);
    const short = await h.http
      .post(`/v1/billing/admin/invoices/${draft.body.id}/pay`)
      .set(platform)
      .send({ amount_cents: finalized.body.total_cents - 1 });
    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({ expected: finalized.body.total_cents });

    const paid = await h.http
      .post(`/v1/billing/admin/invoices/${draft.body.id}/pay`)
      .set(platform)
      .send({ amount_cents: finalized.body.total_cents, reference: "bank-ref-1" });
    expect(paid.status, paid.text).toBe(200);
    expect(paid.body.status).toBe("paid");
    // Paid is terminal.
    expect((await h.http.post(`/v1/billing/admin/invoices/${draft.body.id}/void`).set(platform).send()).status).toBe(422);

    const summary = await h.http.get("/v1/billing/spend-summary").set(tenant.headers);
    expect(summary.body.paid_cents).toBe(paid.body.total_cents);
    expect(summary.body.outstanding_cents).toBeGreaterThanOrEqual(0);
    const monthly = await h.http.get("/v1/billing/spend-monthly").set(tenant.headers);
    expect(monthly.body[0]).toMatchObject({ month: expect.stringMatching(/^\d{4}-\d{2}$/) as unknown as string });

    const revenue = await h.http.get("/v1/billing/admin/revenue-summary").set(platform);
    expect(revenue.body.collected_cents).toBeGreaterThanOrEqual(paid.body.total_cents);
    expect(revenue.body.paying_organizations).toBeGreaterThanOrEqual(1);
  });

  it("drafts overage lines from metered usage and lands a plan-change proration on the next invoice", async () => {
    const tenant = await makeTenant(h, "overage");
    // `ai_tokens` is priced in the catalog (₱0.20 per 1,000) but not included
    // on the free plan, so an operator grant is what puts it in scope — the
    // resolver, not the plan table, is the billing source of truth.
    const grant = await h.http
      .post(`/v1/admin/orgs/${tenant.orgId}/entitlements/grants`)
      .set(platform)
      .send({ feature_key: "limit:ai_tokens", source: "override", limit_value: 10 });
    expect(grant.status, grant.text).toBe(201);
    const metered = await h.http.post("/v1/usage/events").set(tenant.headers).send({ events: [{ metric: "ai_tokens", quantity: 5000 }] });
    expect(metered.status, metered.text).toBe(201);

    const draft = await h.http.post("/v1/billing/invoices/draft").set(tenant.headers).send({});
    expect(draft.status, draft.text).toBe(201);
    const overage = (draft.body.lines as { kind: string; metric: string | null; quantity: number; unit_amount_cents: number; amount_cents: number }[]).find(
      (line) => line.kind === "overage",
    );
    expect(overage, `usage past the included amount must be billed: ${JSON.stringify(draft.body.lines)}`).toBeTruthy();
    expect(overage?.metric).toBe("ai_tokens");
    // 4,990 units over, billed per 1,000 rounded up: 5 x ₱0.20.
    expect(overage).toMatchObject({ quantity: 5, unit_amount_cents: 20, amount_cents: 100 });
    expect((overage?.quantity ?? 0) * (overage?.unit_amount_cents ?? 0)).toBe(overage?.amount_cents);
  });

  it("queues a mid-period plan change as a proration line on the next draft", async () => {
    const tenant = await makeTenant(h, "proration");
    const plans = (await h.http.get("/v1/plans").set(tenant.headers)).body as { key: string; price_cents: number }[];
    const paid = plans.filter((plan) => plan.price_cents > 0).sort((a, b) => a.price_cents - b.price_cents);
    expect(paid.length, "the catalog must ship two paid plans").toBeGreaterThan(1);

    await h.http.post("/v1/billing/checkout").set(tenant.headers).send({ plan_key: (paid[0] as { key: string }).key });
    await h.http.post("/v1/billing/checkout/confirm").set(tenant.headers).send({ plan_key: (paid[0] as { key: string }).key });
    // Halfway through the period, so the arrears correction is non-zero.
    await h.pool.query(
      "UPDATE subscriptions SET current_period_start = now() - interval '15 days', current_period_end = now() + interval '15 days' WHERE organization_id = $1 AND status = 'active'",
      [tenant.orgId],
    );
    const changed = await h.http.post("/v1/subscription/change").set(tenant.headers).send({ plan_key: (paid[1] as { key: string }).key });
    expect(changed.status, changed.text).toBe(200);
    const queued = await h.pool.query<{ pending_adjustments: Record<string, unknown>[] }>(
      "SELECT pending_adjustments FROM subscriptions WHERE organization_id = $1 AND status = 'active'",
      [tenant.orgId],
    );
    expect(queued.rows[0].pending_adjustments.length, "a paid → paid switch prorates in arrears").toBe(1);

    const draft = await h.http.post("/v1/billing/invoices/draft").set(tenant.headers).send({});
    expect(draft.status, draft.text).toBe(201);
    const adjustment = (draft.body.lines as { kind: string; description: string; amount_cents: number }[]).find((line) => line.description.includes("Plan change"));
    expect(adjustment, JSON.stringify(draft.body.lines)).toBeTruthy();
    expect(["custom", "credit"]).toContain(adjustment?.kind);
    // Drained once drafted: the correction is billed exactly once.
    const drained = await h.pool.query<{ pending_adjustments: Record<string, unknown>[] }>(
      "SELECT pending_adjustments FROM subscriptions WHERE organization_id = $1 AND status = 'active'",
      [tenant.orgId],
    );
    expect(drained.rows[0].pending_adjustments).toEqual([]);
  });

  it("dispatches the outbox to a signed endpoint, retries, exhausts, and never fans internal events out", async () => {
    const tenant = await makeTenant(h, "hooks");
    const endpoint = new CaptureEndpoint();
    const url = await endpoint.start();
    try {
      // Endpoint management is milestone 5, so the row is inserted directly —
      // with a Fernet-encrypted secret, exactly as the API will store it.
      const secret = "whsec_integration";
      const endpointId = (
        await h.pool.query<{ id: string }>(
          `INSERT INTO webhook_endpoints (id, organization_id, url, secret_encrypted, events, is_active)
           VALUES (gen_random_uuid(), $1, $2, $3, '{}', true) RETURNING id`,
          [tenant.orgId, url, fernetEncrypt(secret, process.env.SYNAPSE_SECRET_KEY ?? "dev-only-secret-key-change-me-32-bytes-minimum!")],
        )
      ).rows[0].id;

      // Drain the backlog first: the batch under test must be the new events.
      await h.pool.query("DELETE FROM webhook_deliveries");
      for (let i = 0; i < 40 && (await jobs.dispatchOutbox()) > 0; i += 1);
      await h.http.post("/v1/billing/invoices/draft").set(tenant.headers).send({});
      const invoiceId = (await h.pool.query<{ id: string }>("SELECT id FROM invoices WHERE organization_id = $1", [tenant.orgId])).rows[0].id;
      await h.http.post(`/v1/billing/invoices/${invoiceId}/finalize`).set(tenant.headers).send();

      for (let i = 0; i < 40 && (await jobs.dispatchOutbox()) > 0; i += 1);
      const queued = await h.pool.query<{ event_type: string }>("SELECT event_type FROM webhook_deliveries WHERE organization_id = $1", [tenant.orgId]);
      const types = queued.rows.map((row) => row.event_type);
      expect(types).toContain(events.INVOICE_CREATED);
      // `invoice.email` is internal: it drives the notifier, never a tenant endpoint.
      expect(types).not.toContain(events.INVOICE_EMAIL);

      expect(await jobs.deliverWebhooks()).toBeGreaterThan(0);
      const delivered = endpoint.received[0];
      expect(delivered).toBeTruthy();
      const envelope = JSON.parse(delivered?.body ?? "{}") as { event_type: string; organization_id: string; data: Record<string, unknown> };
      expect(envelope.organization_id).toBe(tenant.orgId);
      const [tPart, v1Part] = (delivered?.signature ?? "").split(",");
      const timestamp = Number.parseInt((tPart ?? "").replace("t=", ""), 10);
      expect(verifySignature(Buffer.from(delivered?.body ?? "", "utf8"), secret, timestamp, (v1Part ?? "").replace("v1=", ""))).toBe(true);

      // A rejecting endpoint retries with backoff until it is exhausted.
      endpoint.status = 500;
      const failing = (
        await h.pool.query<{ id: string }>(
          `INSERT INTO webhook_deliveries (id, endpoint_id, organization_id, event_type, payload, status, attempts, max_attempts)
           VALUES (gen_random_uuid(), $1, $2, 'invoice.created', '{}'::jsonb, 'pending', 0, 6) RETURNING id`,
          [endpointId, tenant.orgId],
        )
      ).rows[0].id;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        await h.pool.query("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1 AND status = 'pending'", [failing]);
        await jobs.deliverWebhooks();
      }
      const finalState = await h.pool.query<{ status: string; attempts: number; last_response_code: number }>(
        "SELECT status, attempts, last_response_code FROM webhook_deliveries WHERE id = $1",
        [failing],
      );
      expect(finalState.rows[0]).toMatchObject({ status: "exhausted", attempts: 6, last_response_code: 500 });
    } finally {
      await endpoint.stop();
    }
  });

  it("dead-letters an outbox event after eight attempts instead of pinning the batch", async () => {
    const tenant = await makeTenant(h, "deadletter");
    // Deterministic batch: only this event is pending, and only this org has an
    // endpoint, so the fan-out that fails is the one under test.
    await h.pool.query("DELETE FROM outbox_events WHERE published_at IS NULL");
    await h.pool.query("DELETE FROM webhook_endpoints");
    await h.pool.query(
      `INSERT INTO webhook_endpoints (id, organization_id, url, secret_encrypted, events, is_active)
       VALUES (gen_random_uuid(), $1, 'http://127.0.0.1:1/never', '\\x00'::bytea, '{}', true)`,
      [tenant.orgId],
    );
    const eventId = (
      await h.pool.query<{ id: string }>(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, organization_id, event_type, payload, audience, attempts, next_attempt_at)
         VALUES (gen_random_uuid(), 'invoice', gen_random_uuid(), $1, 'invoice.created', '{}'::jsonb, 'public', 7, now()) RETURNING id`,
        [tenant.orgId],
      )
    ).rows[0].id;
    // A constraint that always fails makes the fan-out insert blow up
    // deterministically. NOT VALID skips the scan of existing rows but is
    // still enforced for new ones.
    await h.pool.query("ALTER TABLE webhook_deliveries ADD CONSTRAINT tmp_fail CHECK (false) NOT VALID");
    try {
      expect(await jobs.dispatchOutbox()).toBe(0);
      const row = await h.pool.query<{ attempts: number; dead_at: Date | null; last_error: string | null; published_at: Date | null }>(
        "SELECT attempts, dead_at, last_error, published_at FROM outbox_events WHERE id = $1",
        [eventId],
      );
      expect(row.rows[0]).toMatchObject({ attempts: 8, published_at: null });
      expect(row.rows[0].dead_at).not.toBeNull();
      expect(row.rows[0].last_error).toContain("tmp_fail");
      // Dead rows are never claimed again.
      expect(await jobs.dispatchOutbox()).toBe(0);
    } finally {
      await h.pool.query("ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS tmp_fail");
      await h.pool.query("DELETE FROM webhook_endpoints");
    }
  });

  it("ingests manual webhooks idempotently and refuses unsigned ones", async () => {
    const tenant = await makeTenant(h, "ingest");
    const planKey = await paidPlanKey(tenant);
    await h.http.post("/v1/billing/checkout").set(tenant.headers).send({ plan_key: planKey });
    await h.http.post("/v1/billing/checkout/confirm").set(tenant.headers).send({ plan_key: planKey });
    const customerId = (
      await h.pool.query<{ provider_customer_id: string }>("SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1", [tenant.orgId])
    ).rows[0].provider_customer_id;

    await h.pool.query("DELETE FROM provider_webhook_events");
    const eventId = `mev_${Date.now().toString(16)}`;
    const body = JSON.stringify({ id: eventId, type: "manual.subscription.canceled", data: { customer_id: customerId } });
    const post = (): request.Test =>
      h.http.post("/v1/billing/webhooks/manual").set("X-Manual-Token", "manual-token-for-tests").set("Content-Type", "application/json").send(body);

    const first = await post();
    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({ status: "processed", events_applied: 1 });
    expect((await h.pool.query("SELECT 1 FROM subscriptions WHERE organization_id = $1 AND status = 'canceled'", [tenant.orgId])).rowCount).toBe(1);

    // A replay is a 200 no-op: the ledger's unique (provider, event id) holds.
    const replay = await post();
    expect(replay.body).toMatchObject({ status: "duplicate", events_applied: 0 });
    const ledger = await h.pool.query<{ processed_at: Date | null }>("SELECT processed_at FROM provider_webhook_events WHERE provider_event_id = $1", [eventId]);
    expect(ledger.rowCount).toBe(1);
    expect(ledger.rows[0].processed_at).not.toBeNull();

    // An unsigned request never reaches the ledger.
    const unsigned = await h.http.post("/v1/billing/webhooks/manual").set("Content-Type", "application/json").send("{}");
    expect(unsigned.status).toBe(400);
    expect(unsigned.body).toMatchObject({ title: "webhook signature invalid" });
    expect((await h.pool.query("SELECT 1 FROM provider_webhook_events")).rowCount).toBe(1);

    // An unknown provider is a 404, not a 500 from the registry.
    expect((await h.http.post("/v1/billing/webhooks/nope").set("Content-Type", "application/json").send("{}")).status).toBe(404);
  });

  it("records a business rejection on the ledger, and rolls an infrastructure failure back with it", async () => {
    const tenant = await makeTenant(h, "ledger");
    const planKey = await paidPlanKey(tenant);
    await h.http.post("/v1/billing/checkout").set(tenant.headers).send({ plan_key: planKey });
    const customerId = (
      await h.pool.query<{ provider_customer_id: string }>("SELECT provider_customer_id FROM billing_customers WHERE organization_id = $1", [tenant.orgId])
    ).rows[0].provider_customer_id;
    const service = h.app.get(BillingWebhooksService);
    const stub = (providerEventId: string, translate: () => unknown): unknown => ({
      name: "manual",
      supports: new Set(),
      verifyWebhook: () => Promise.resolve({ providerEventId, eventType: "stub", parsed: {}, receivedAt: new Date() }),
      translateWebhook: translate,
    });
    const raw = { headers: {}, body: Buffer.from("{}") };

    // A payload we cannot translate will not translate on retry either:
    // recorded on the ledger row, answered 200, the row KEPT.
    const untranslatable = await service.handle("manual", raw, stub("mev_translate", () => {
      throw new Error("unmappable payload");
    }) as never);
    expect(untranslatable).toMatchObject({ status: "unprocessable", events_applied: 0, events_rejected: 1 });
    expect((await h.pool.query<{ error: string }>("SELECT error FROM provider_webhook_events WHERE provider_event_id = 'mev_translate'")).rows[0].error).toContain(
      "unmappable payload",
    );

    // A business rejection (an unknown plan on checkout.completed) is
    // deterministic: recorded, 200, and the rest of the batch survives.
    const rejected = await service.handle("manual", raw, stub("mev_reject", () => [
      { eventType: "checkout.completed", providerEventId: "mev_reject", occurredAt: new Date(), providerCustomerId: customerId, planKey: "no-such-plan" },
    ]) as never);
    expect(rejected).toMatchObject({ status: "processed", events_applied: 0, events_rejected: 1 });
    expect((await h.pool.query<{ error: string }>("SELECT error FROM provider_webhook_events WHERE provider_event_id = 'mev_reject'")).rows[0].error).toContain(
      "checkout.completed",
    );

    // An infrastructure failure while APPLYING propagates: the ledger row
    // rolls back with the transaction so the provider's retry re-processes it.
    await h.pool.query("ALTER TABLE invoices ADD CONSTRAINT tmp_infra CHECK (false) NOT VALID");
    try {
      await expect(
        service.handle("manual", raw, stub("mev_infra", () => [
          {
            eventType: "invoice.paid",
            providerEventId: "mev_infra",
            occurredAt: new Date(),
            providerCustomerId: customerId,
            providerInvoiceId: "prov_inv_infra",
            amountCents: 100,
            currency: "PHP",
          },
        ]) as never),
      ).rejects.toBeTruthy();
    } finally {
      await h.pool.query("ALTER TABLE invoices DROP CONSTRAINT IF EXISTS tmp_infra");
    }
    expect((await h.pool.query("SELECT 1 FROM provider_webhook_events WHERE provider_event_id = 'mev_infra'")).rowCount).toBe(0);
  });

  it("renews a locally billed subscription: the ended period is invoiced, then rolled forward", async () => {
    const tenant = await makeTenant(h, "renewal");
    const planKey = await paidPlanKey(tenant);
    await h.http.post("/v1/billing/checkout").set(tenant.headers).send({ plan_key: planKey });
    await h.http.post("/v1/billing/checkout/confirm").set(tenant.headers).send({ plan_key: planKey });
    await h.pool.query("DELETE FROM invoices WHERE organization_id = $1", [tenant.orgId]);

    const before = await h.pool.query<{ id: string; current_period_end: Date }>(
      "UPDATE subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 day' WHERE organization_id = $1 AND status = 'active' RETURNING id, current_period_end",
      [tenant.orgId],
    );
    expect(before.rowCount).toBe(1);

    expect(await jobs.advanceRecurringBilling()).toBeGreaterThan(0);

    const invoices = await h.pool.query<{ status: string; number: string | null; total_cents: number }>(
      "SELECT status, number, total_cents FROM invoices WHERE organization_id = $1",
      [tenant.orgId],
    );
    expect(invoices.rowCount).toBe(1);
    expect(invoices.rows[0].status).toBe("open");
    expect(invoices.rows[0].number).toMatch(/^INV-\d{6}-\d{4}$/);

    const after = await h.pool.query<{ current_period_start: Date; current_period_end: Date }>(
      "SELECT current_period_start, current_period_end FROM subscriptions WHERE id = $1",
      [before.rows[0].id],
    );
    expect(after.rows[0].current_period_start.getTime()).toBe(before.rows[0].current_period_end.getTime());
    expect(after.rows[0].current_period_end.getTime()).toBeGreaterThan(Date.now());
    // A second pass has nothing to renew.
    expect(await jobs.advanceRecurringBilling()).toBe(0);
  });

  it("emails the invoice with its PDF attached, and the invite/reset links", async () => {
    const tenant = await makeTenant(h, "mail");
    // Drain whatever earlier journeys queued, so the mailbox under test is this one's.
    for (let i = 0; i < 40 && (await jobs.dispatchOutbox()) > 0; i += 1);
    sent.length = 0;
    const draft = await h.http.post("/v1/billing/invoices/draft").set(tenant.headers).send({});
    await h.http.post(`/v1/billing/invoices/${draft.body.id}/finalize`).set(tenant.headers).send();
    await h.http.post("/v1/orgs/current/members/invite").set(tenant.headers).send({ email: `invitee-${Date.now().toString(16)}@example.com` });
    await h.http.post("/v1/auth/forgot-password").send({ email: tenant.email });

    for (let i = 0; i < 20; i += 1) await jobs.dispatchOutbox();

    const invoiceEmail = sent.find((message) => message.subject.startsWith("Invoice "));
    expect(invoiceEmail, `no invoice email in ${JSON.stringify(sent.map((m) => m.subject))}`).toBeTruthy();
    expect(invoiceEmail?.to).toBe(tenant.email);
    const attachment = invoiceEmail?.attachments?.[0];
    expect(attachment?.contentType).toBe("application/pdf");
    expect(attachment?.content.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const invite = sent.find((message) => message.subject.startsWith("You've been invited"));
    expect(invite?.body).toContain("/register?invite=");
    const reset = sent.find((message) => message.subject === "Reset your password");
    expect(reset?.body).toContain("/login?reset=");
  });

  it("maintains partitions and honours retention", async () => {
    expect(await jobs.ensurePartitions()).toBe(4);
    const now = new Date();
    for (let ahead = 0; ahead <= 3; ahead += 1) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
      const name = `usage_events_y${String(month.getUTCFullYear())}m${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
      const exists = await h.pool.query("SELECT to_regclass($1) AS oid", [`public.${name}`]);
      expect(exists.rows[0].oid, `${name} must exist`).not.toBeNull();
    }

    await h.pool.query(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, audience, attempts, created_at, published_at)
       VALUES (gen_random_uuid(), 'invoice', gen_random_uuid(), 'invoice.created', '{}'::jsonb, 'public', 0, now() - interval '30 days', now() - interval '30 days')`,
    );
    const fresh = await h.pool.query<{ id: string }>(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, audience, attempts, published_at)
       VALUES (gen_random_uuid(), 'invoice', gen_random_uuid(), 'invoice.created', '{}'::jsonb, 'public', 0, now()) RETURNING id`,
    );
    expect(await jobs.purgeExpired()).toBeGreaterThan(0);
    const stale = await h.pool.query("SELECT 1 FROM outbox_events WHERE published_at < now() - interval '8 days'");
    expect(stale.rowCount).toBe(0);
    const kept = await h.pool.query("SELECT 1 FROM outbox_events WHERE id = $1", [fresh.rows[0].id]);
    expect(kept.rowCount).toBe(1);
  });

  it("refuses to draft for an organization with nothing to bill", async () => {
    const tenant = await makeTenant(h, "nosub");
    await h.pool.query("UPDATE subscriptions SET status = 'canceled' WHERE organization_id = $1", [tenant.orgId]);
    const draft = await h.http.post("/v1/billing/invoices/draft").set(tenant.headers).send({});
    expect(draft.status).toBe(422);
    expect(draft.body.detail).toBe(new InvalidRequestError("Organization has no active subscription to bill").message);
    // An impossible month is a 422 from the parser, never a 500.
    expect((await h.http.post("/v1/billing/invoices/draft").set(tenant.headers).send({ period: "2026-13" })).status).toBe(422);
  });
});
