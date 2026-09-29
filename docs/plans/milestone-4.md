# Milestone 4 — billing providers, invoicing, notifications, worker

Planned by the coordinator against the reference at `synapse-saas@295672b`.
Everything below names the reference file that holds the exact behaviour;
read that file before writing the port's version. Where this plan and the
reference disagree, the reference server wins — report the discrepancy.

## Gate

`tests/conformance/test_billing.py` (6 tests) green against this server with
`SYNAPSE_BILLING_PROVIDER=manual`, plus **no regression** in milestones 1–3
(`test_meta_and_health`, `test_problem_documents`, `test_auth`, `test_tenancy`,
`test_authorization`, `test_api_keys`, `test_subscriptions`,
`test_usage_and_entitlements`). Only permitted failure:
`test_usage_and_entitlements.py::test_feature_gate_problem_shape` (needs
`GET /v1/agents`, milestone 5).

## 0. Re-pin the contract

Copy `contracts/openapi-v1.json`, `events.json`, `problems.json` (now
`classes[]` per title), `CHANGELOG.md`, `schema-v1.sql` from the reference at
`295672b`; bump the README pin. Mirror the one behaviour change since the last
pin: `period` inputs (`GET /v1/usage/summary?period=`, `POST
/v1/billing/invoices/draft {period}`) validate the month with
`^\d{4}-(0[1-9]|1[0-2])$` → 422 `validation_failed` (was 500).

## 1. Provider abstraction — `billing/protocol.py`, `billing/registry.py`

- `BillingCapability` (read the enum, lines 24–36) and the DTOs
  `WebhookRequest`, `VerifiedWebhook`, `NormalizedBillingEvent` (canonical
  `event_type` vocabulary: customer.created, subscription.created/activated/
  updated/canceled/past_due/trial_ended, invoice.created/paid/failed,
  checkout.completed, payment.failed), `BillingCustomerRef`, `CheckoutResult`,
  `SubscriptionRef`, `InvoiceRef`, `CreateCustomerRequest`,
  `CreateCheckoutRequest`, `CreateSubscriptionRequest`, `ChangePlanRequest`.
- `BillingProvider` interface: `create_customer`, `create_checkout`,
  `billing_portal_url`, `create_subscription`, `change_plan`,
  `cancel_subscription`, `get_subscription`, `list_invoices`,
  `verify_webhook`, `translate_webhook`, class-level `supports`.
- Registry: `build_provider(name=settings.billing_provider)`; a hosted
  provider whose secret setting is empty → 409 `billing_provider_not_configured`;
  `locally_billed_provider_names()` = every provider WITHOUT the hosted
  recurring capability (these are renewed by the worker, §6).
- Providers (`billing/providers/*_provider.py`):
  - **manual**: complete. Checkout returns `url: null` +
    `manual_instructions` (from `SYNAPSE_MANUAL_PAY_TO_INSTRUCTIONS`), confirm
    activates the plan, webhook ingest requires the manual token (read the
    header name in `manual_provider.py`).
  - **stripe**: form-encoded REST (`https://api.stripe.com/v1/...`, HTTP Basic
    with the secret key as username, empty password): customers, checkout sessions, billing-portal sessions,
    subscription item update (plan change), cancel, invoices list. Webhook:
    `Stripe-Signature: t=…,v1=…`, HMAC-SHA256 over `"{t}.{raw_body}"`,
    tolerance window, constant-time compare.
  - **paddle**: `Paddle-Signature: ts=…;h1=…` over `"{ts}:{raw_body}"`.
  - **xendit**: `x-callback-token` header equals the configured token.
  - **paymongo**: read `paymongo_provider.py` for the header/scheme.
  Money stays integer minor units end to end (ADR 0006): never `int(float*100)`.
  The HTTP client is injectable so tests can point providers at a local stub.
- Settings (same names): `SYNAPSE_BILLING_PROVIDER`, `SYNAPSE_STRIPE_SECRET_KEY`,
  `SYNAPSE_STRIPE_WEBHOOK_SECRET`, `SYNAPSE_PADDLE_SECRET_KEY`,
  `SYNAPSE_PADDLE_WEBHOOK_SECRET`, `SYNAPSE_XENDIT_SECRET_KEY`,
  `SYNAPSE_XENDIT_WEBHOOK_TOKEN`, `SYNAPSE_PAYMONGO_SECRET_KEY`,
  `SYNAPSE_PAYMONGO_WEBHOOK_SECRET`, `SYNAPSE_MANUAL_WEBHOOK_TOKEN`,
  `SYNAPSE_MANUAL_PAY_TO_INSTRUCTIONS`, `SYNAPSE_BILLING_CURRENCY`,
  `SYNAPSE_WEB_ORIGIN` (checkout success/cancel + portal return URLs are
  `{web_origin}/dashboard/billing?...`).

## 2. Checkout, portal, plan change — `billing/service.py`, `billing/router.py`

- `POST /v1/billing/checkout {plan_key}` (`billing:manage`): `ensure_customer`
  (row in `billing_customers`, provider customer created for hosted
  providers) → `start_checkout` → `CheckoutResponse {url, provider,
  manual_instructions}`.
- `POST /v1/billing/checkout/confirm {plan_key}`: only for providers with the
  client-confirm capability (manual); others → 409
  `checkout_confirm_not_allowed`. `complete_checkout(source=…)` is shared with
  the webhook path.
- `GET /v1/billing/portal-url` → `{url}`; `null` when the provider has no
  portal or the org has no provider customer.
- `BillingService.change_plan`: fill the milestone-3 seam — hosted provider
  with `provider_subscription_id` → `provider.change_plan(...)` then apply the
  local transition; keep the local path and the 409 `checkout_required`.

## 3. Billing webhooks — `billing/webhooks.py`, route `POST /v1/billing/webhooks/{provider}`

- The route reads the RAW request body (signature is over bytes).
- Ledger table `provider_webhook_events` (columns in `schema-v1.sql`):
  unique per `(provider, provider_event_id)`; a replay answers 200 without
  re-applying.
- Flow: `verify_webhook` (bad/missing signature → 400 `webhook_signature_invalid`) → `translate_webhook` → insert ledger row → `_apply` in the same
  transaction. A `DomainError` from `_apply` is recorded on the ledger row
  (`error` column) and the response is 200; any other exception propagates
  (500) so the transaction, ledger row included, rolls back and the provider
  retries.
- `_apply`: `_apply_status` (subscription transitions via the state machine,
  `current_period_end`, events), `_apply_checkout_completed`
  (`complete_checkout(source="webhook")`), `_upsert_invoice` (provider
  invoices → `invoices` rows with `hosted_url`, `invoice.paid`/`invoice.failed`
  events). Org lookup by provider customer/subscription id goes through the
  SECURITY DEFINER function the baseline provides for RLS mode (grep
  `synapse_org_for` in `schema-v1.sql`) — the API role cannot see the row
  before the tenant is bound.

## 4. Invoicing — `billing/invoicing.py`, `billing/invoice_pdf.py`

- Statuses `draft|open|paid|void|uncollectible`; read `INVOICE_TRANSITIONS`
  and `_assert_invoice_transition` (422 `validation_failed` with
  `from/to/allowed` extras).
- `draft_for_org(org, period, created_by)`: reuse an existing draft for the
  period (idempotent); requires an active subscription (422 "Organization has
  no active subscription to bill"); lines = plan line (snapshot price) +
  `_overage_lines` (per metric with an overage: `quantity =
  ceil(units_over / unit)`, `unit_amount_cents = price_cents`, `amount =
  quantity × unit_amount` — they reconcile) + `_adjustment_lines` drained from
  `subscriptions.pending_adjustments` (cleared once drafted) + credit
  carry-forward; totals in the org's currency. Response 201
  `InvoiceDetailRead` (`InvoiceRead` fields + `lines[]` of
  `InvoiceLineRead {id, kind, description, quantity, unit_amount_cents,
  amount_cents, metric}`).
- `finalize`: lock the org row (`SELECT … FOR UPDATE`), `_next_number`
  (read the format; unique `(organization_id, number)`), `issued_at`, status
  `open` — check what the reference does for a zero total (the conformance
  test accepts open-at-0 or paid). Emits public `invoice.created` and internal
  `invoice.email`.
- `record_payment(amount_cents > 0, reference)` → `paid`, `paid_at`,
  `invoice.paid`; `void` → transition rules (paid → 422). Operator routes
  `POST /v1/billing/admin/invoices/{id}/pay|void` are platform-admin only
  (tenants get 404). Tenant routes: `GET /v1/billing/invoices` (paged,
  `X-Total-Count`), `GET /v1/billing/invoices/{id}`,
  `POST /v1/billing/invoices/draft`, `POST /v1/billing/invoices/{id}/finalize`,
  `GET /v1/billing/invoices/{id}/pdf`.
- PDF: `application/pdf`, `Content-Disposition: attachment`, starts with
  `%PDF`; sections as `invoice_pdf.py`: `_header` (org name, number),
  `_bill_to` (org name, billing email), `_meta` (dates, status), `_table`
  (lines), `_totals`, `_instructions` (pay-to text for manual). Latin-1
  sanitising is a font limitation of fpdf — match the visible content, not
  the byte layout.

## 5. Reporting — `billing/reporting.py`

- `GET /v1/billing/spend-summary` → `{organization_id, billed_cents,
  paid_cents, outstanding_cents, void_cents, by_status, currency}`;
  `GET /v1/billing/spend-monthly` → `[{month, total_cents, invoices}]`
  (12 months).
- Operator: `GET /v1/billing/admin/revenue-summary` → `{mrr_proxy_cents,
  collected_cents, outstanding_cents, paying_organizations,
  invoices_by_status, as_of}`; `GET /v1/billing/admin/revenue-monthly` →
  `[{month, collected_cents, invoices}]`. Read the SQL for the exact
  definitions (MRR proxy, which statuses count as outstanding).

## 6. Worker — `worker/jobs.py`, `worker/__init__.py`, `cli.py jobs run-once`

Constants (copy exactly): `OUTBOX_BATCH=20`, `DELIVERY_BATCH=20`,
`OUTBOX_MAX_ATTEMPTS=8`, `OUTBOX_BACKOFF_SECONDS=(5,30,120,600,1800,3600,3600,3600)`,
`DELIVERY_BACKOFF_SECONDS=(60,300,1800,7200,21600)`,
`MAX_DELIVERY_ATTEMPTS=6`, `RENEWAL_BATCH=100`, `PARTITION_MONTHS_AHEAD=3`,
retention `IDEMPOTENCY 90d`, `DELIVERY 30d`, `EXHAUSTED_DELIVERY 90d`,
`OUTBOX 7d`, audit `SYNAPSE_AUDIT_RETENTION_DAYS` (365).

Cadences: `dispatch_outbox` every 5 s; `deliver_webhooks` every 15 s;
`rollup_usage` hourly at :05; `expire_entitlements` hourly at :10;
`advance_recurring_billing` hourly at :20; `ensure_partitions` daily 03:30;
`purge_expired` daily 03:40.

Coordination: **no new tables**. Each job takes
`pg_try_advisory_lock(hashtext('job:<name>'))` on a dedicated connection and
skips the tick if it is held; rows are claimed with `FOR UPDATE SKIP LOCKED`.

- `dispatch_outbox` (`_dispatch_outbox_impl`, `_outbox_failure`, `_outbox_row`):
  claim pending rows (`published_at IS NULL AND dead_at IS NULL AND
  next_attempt_at <= now()`), per-event savepoint; `audience = 'public'` →
  fan out to the org's active `webhook_endpoints` whose `events` filter is
  empty or contains the type, inserting `webhook_deliveries` rows with the
  envelope from `WebhookService.build_envelope`; internal events are never
  fanned out. Mark `published_at`. On failure: `attempts += 1`, `last_error`,
  `next_attempt_at = now + backoff[attempts-1]`, `dead_at` once attempts reach
  8 (+ metric). After the commit, run the post-commit consumers for the
  batch: `notifications.handle_event(event_type, payload)` (best effort,
  logged); leave a hook for the milestone-7 OpenFGA consumer.
- `deliver_webhooks` (`WebhookService.deliver`, `_mark_failure`): claim due
  deliveries, POST the stored body with `X-Synapse-Signature:
  t=<unix>,v1=<hex HMAC-SHA256 over "<unix>.<body>" with the endpoint
  secret>` plus the other headers the reference sends, timeout as the
  reference; 2xx → `delivered`; otherwise `attempts += 1`, next attempt from
  the ladder, `exhausted` after `MAX_DELIVERY_ATTEMPTS`. Endpoint secrets are
  Fernet-encrypted at rest under `SYNAPSE_SECRET_KEY` — implement a
  Fernet-compatible codec (AES-128-CBC + HMAC-SHA256, base64url; the spec is
  small) so endpoints created by any implementation are deliverable by any
  other.
- `rollup_usage`, `expire_entitlements` (`entitlement.expired` events +
  invalidation), `advance_recurring_billing` (locally billed providers,
  `status = 'active'`, `current_period_end <= now()`, batch 100, savepoint per
  subscription, `_renew_locally_billed`: draft + finalize the ENDED period
  through the invoicing engine, advance the period, honour
  `cancel_at_period_end`), `ensure_partitions` (monthly `usage_events_*`
  partitions through +3 months; read the naming), `purge_expired` (each
  retention above; `exhausted` deliveries kept 90 d).
- `jobs run-once [--all | names…]`: runs each job once, prints `name: count`
  per line, non-zero exit on an unknown name or nothing selected.
- Worker runs in-process with the API by default (`SYNAPSE_WORKER_ENABLED`)
  and as a standalone entrypoint.

## 7. Notifications — `notifications/smtp.py`, `notifications/handlers.py`

- `Notifier` (`send(to, subject, text, html?, attachments?)`); `SmtpNotifier`
  from `SYNAPSE_SMTP_HOST/PORT/FROM/USERNAME/PASSWORD/TLS (none|starttls|ssl)`;
  `NoopNotifier` when the host is empty or `SYNAPSE_NOTIFIER=noop`; send
  failures are logged, never raised.
- Handlers (`handle_event`): `member.invite_email` → "You've been invited to
  {org}" with the accept link; `user.password_reset_link` → "Reset your
  password"; `invoice.email` → `_send_invoice_email(invoice_id)` (loads the
  invoice, recipient via `billing_recipient(org)` = billing customer email →
  org owner, attaches the PDF); `usage.soft_limit_reached` → "You're
  approaching your {metric} limit". Read the bodies and links.

## 8. Retrofits

- `/readyz`: `checks.database`, and `checks.redis = "not_configured"` while
  the port has no Redis (the reference reports exactly that when unset).
- Entitlement invalidation seam called where the reference bumps its cache
  (grants, plan changes, webhook transitions).

## 9. Tests

Unit: signature matrices for all four providers (valid, tampered body,
wrong secret, stale timestamp, replayed event id), `translate_webhook`
fixtures per provider, invoice line reconciliation (`qty × unit == amount`),
`INVOICE_TRANSITIONS`, `_next_number`, backoff ladders, event audience, PDF
bytes start with `%PDF`.
DB journeys: manual checkout → confirm → draft/finalize/pdf/pay/void;
overage lines from consumed usage; plan change whose proration lands on the
next draft; recurring-billing job renews an ended period and drafts+finalizes;
outbox dispatch fans out to an endpoint row inserted directly (routes are
milestone 5) with a verifiable signature; retry → exhausted; dead-letter after
8 attempts; internal events never reach deliveries; webhook ingest: replayed
event 200-no-op, DomainError recorded + 200, unexpected error → 500 and no
ledger row; invite/reset/invoice emails captured by an in-process SMTP stub
with the PDF attached; `ensure_partitions` creates +3 months; `purge_expired`
honours retention; provider clients against a local stub HTTP server.

## 10. Order of work

1. §0 re-pin + period validation → commit.
2. §4 invoicing + PDF + tenant/operator routes, §5 reporting → the invoice,
   void, reports conformance tests pass → commit.
3. §1 manual provider + §2 checkout/confirm/portal + §3 ingest with ledger →
   checkout, portal, unsigned-webhook tests pass → commit.
4. §1 hosted providers + signature verification + unit matrices → commit.
5. §6 dispatch + deliveries + Fernet + §7 notifications → commit.
6. §6 remaining jobs + run-once + standalone worker → commit.
7. §9 journeys, README (status row, env table, worker/run-once/conformance
   targets), full conformance run, push.

## Port-specific mapping (Node / NestJS)

| Piece | Module / file | Notes |
|---|---|---|
| Provider DTOs + interface | `src/billing/providers.ts` (extend) | `fetch` injected (`FetchLike`) so tests point providers at a local stub |
| Providers | `src/billing/providers/{manual,stripe,paddle,xendit,paymongo}.provider.ts` | replace the capability-only descriptors |
| Registry | `src/billing/registry.ts` | `buildProvider(name)`, `locallyBilledProviderNames()` |
| Checkout/portal/change | `src/billing/billing.service.ts`, `src/billing/billing.controller.ts` (`BillingRoutesModule`) | fill `changePlanWithProvider` |
| Webhook ingest | `src/billing/webhooks/{billing-webhooks.service.ts,billing-webhooks.controller.ts,ledger.repository.ts}` | raw body: `express.raw({ type: '*/*' })` mounted for `/v1/billing/webhooks/:provider` BEFORE the JSON parser in `main.ts` (or `NestFactory.create(..., { rawBody: true })` + `req.rawBody`) |
| Invoicing | `src/billing/invoicing/{invoicing.service.ts,invoices.repository.ts,invoice-numbering.ts,invoice-pdf.ts,invoices.controller.ts}` | PDF with `pdfkit` (+ `@types/pdfkit`), collected into a Buffer |
| Reporting | `src/billing/reporting/{reporting.service.ts,reporting.controller.ts}` | SQL mirrored from `reporting.py` |
| Outbox dispatch + deliveries | `src/webhooks/{delivery.service.ts,signer.ts,fernet.ts,envelope.ts}` | `fernet.ts` = AES-128-CBC + HMAC-SHA256 per the Fernet spec (node `crypto`), key = `SYNAPSE_SECRET_KEY` as the reference derives it (read `webhooks/service.py::_fernet`) |
| Worker | `src/worker/{advisory-lock.ts,jobs.service.ts,worker.module.ts,worker.ts}`, `src/cli/jobs-run-once.ts` | `@nestjs/schedule` (`ScheduleModule.forRoot()`, `@Cron`/`@Interval`), enabled by `SYNAPSE_WORKER_ENABLED` (default true in-process); `pnpm worker` standalone; `pnpm jobs:run-once [--all|names]` prints `name: count` lines |
| Notifications | `src/notifications/{notifier.ts,smtp.notifier.ts,noop.notifier.ts,handlers.ts,notifications.module.ts}` | `nodemailer` (+ types); `smtp-server` (dev) as the capture stub in tests |
| Provider stubs in tests | `test/support/stub-provider-server.ts` | `http.createServer` |

Existing conventions to keep: `Database.transaction(fn)` with RLS GUC
priming, repositories over plain `pg`, guards (`AuthGuard`, `TenantGuard`,
`PermissionsGuard`, `PlatformAdminGuard`, `FeatureGuard`), `ProblemFilter`,
`OutboxWriter` / `AuditWriter` in the same transaction, zod settings in
`src/core/config.ts`, acyclic module graph (engines never import route
modules; `BillingModule` may import `SubscriptionsModule`, `EntitlementsModule`,
`UsageModule`; `WorkerModule` imports the engines it drives).

Runtime: `postgresql://synapse:synapse@localhost:5434/synapse_node` (server)
and `synapse_node_test` (tests; `pnpm test:db` truncates it); `PORT=8090`;
boot with the operator bootstrap env; `pnpm conformance` must cover
milestones 1–4.
