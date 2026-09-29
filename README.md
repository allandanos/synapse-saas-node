# synapse-saas-node

NestJS 11 / TypeScript implementation of the **Synapse SaaS Framework contract
v1**. The reference implementation, the contract, and the acceptance suite live
in [`synapse-saas`](../synapse-saas) — see its
[ADR 0012](../synapse-saas/docs/adr/0012-polyglot-ports-contract-first.md) and
[porting guide](../synapse-saas/ports/README.md).

**Contract pinned at:** `synapse-saas@cd55a53` (`contracts/` is a snapshot of
that commit; re-copy when the reference's `contracts/CHANGELOG.md` gains an entry).

## Status

| Milestone | Scope | State |
|---|---|---|
| 1 | pure logic + core + probes/`/v1/meta` | **done** — `/healthz`, `/readyz`, `/v1/meta`, typed settings, problem documents, request context, DB + RLS GUCs, raw-SQL migrations, outbox + audit writers |
| 2 | identity, tenancy, authorization (RBAC), API keys | **done** — `test_meta_and_health`, `test_problem_documents`, `test_auth`, `test_tenancy`, `test_authorization`, `test_api_keys` pass |
| 3 | subscriptions, entitlements, usage | **done** — `test_subscriptions` (4/4), `test_usage_and_entitlements` (8/8), `test_api_keys` fully, no milestone-2 regression (`pnpm conformance:m3`) |
| 4 | billing providers, invoicing, notifications, worker | **done** — `test_billing` (6/6) plus no milestone 1–3 regression (`pnpm conformance:m4`) |
| 5 | webhooks, files, flags, audit, agents | **done** — `test_webhooks`, `test_files`, `test_feature_flags`, `test_audit`, `test_agents` pass and the **whole** reference suite is green (51/51, `pnpm conformance`) |
| 6 | console parity (Playwright) | — |
| 7 | OIDC + OpenFGA, hardening | — |

A milestone is done when the corresponding `tests/conformance` modules pass
against this server (`pnpm conformance`).

Deferred to later milestones: the Redis-backed caches — entitlements are
computed per request behind `EntitlementsService.effectiveForOrg` and flags are
evaluated per check behind `FlagsService.evaluate`; the reference's
invalidation points are marked by `EntitlementsService.invalidate` and
`FlagsService.invalidate` — Stripe catalog plan-sync from the CLI
(`StripeBillingProvider.upsertProductAndPrice` exists, `plans:sync` does not
call it), and auth rate limiting.

## Stack

NestJS 11 · `nestjs-cls` (AsyncLocalStorage request context: request id, user,
tenant) · `pg` with small hand-written repositories and **raw SQL migrations**
(`migrations/001_baseline.sql` = `contracts/schema-v1.sql`; Prisma cannot express
the partial indexes / BRIN / partitioning / RLS policies this schema uses, and an
ORM's generated DDL is ruled out by ADR 0012) · `class-validator` DTOs →
`validation_failed` problem documents · `@node-rs/argon2` (argon2id, same
parameters as the reference) · `jsonwebtoken` (HS256, same claims) · zod-typed
settings and plan catalog (`yaml` parses `config/plans.yaml`) · `pdfkit` (invoice
PDFs) · `nodemailer` (SMTP) · `@nestjs/schedule` (the worker's cadence) ·
`multer` (multipart uploads, memory storage) and `@aws-sdk/client-s3` +
`@aws-sdk/s3-request-presigner` (the S3-compatible storage backend and its
SigV4 presigning; the local-disk backend needs neither) · Vitest + supertest.

### Design notes

- **Problem documents everywhere.** A global `ProblemFilter` renders
  `DomainError`s (`src/core/errors.ts`, one class per entry of
  `contracts/problems.json`), Nest's own 404/405, body-parse failures and
  DTO-validation failures (`422 validation_failed` with `errors[]`), and 500s as
  RFC 7807 documents carrying `instance` and `request_id`. Extras never shadow
  the RFC members.
- **Request context** lives in `nestjs-cls`; guards populate it
  (`AuthGuard` → user or API-key principal, `TenantGuard` → tenant,
  `PermissionsGuard` → effective permission keys) and services + the database
  layer read it. Nothing threads a tenant as a parameter.
- **Transactions are owned by services.** `Database.transaction(fn)` opens one
  transaction per unit of work, primes the RLS GUCs (`app.current_user`,
  `app.current_tenant`, `app.rls_platform`, transaction-local via
  `set_config(..., true)`) from the request context, and commits before the
  controller serialises. There is no commit-before-send middleware. A service
  binds a tenant mid-transaction where the reference does (org creation, invite
  acceptance); `TenantGuard` binds the tenant before the membership query.
  Every GUC write is a no-op unless `SYNAPSE_TENANT_ISOLATION=app_and_rls`, and
  boot refuses a role/isolation mismatch like the reference.
- **Outbox + audit in the same transaction.** `OutboxWriter` stamps
  `audience` from the event vocabulary (`member.invite_email` and
  `user.password_reset_link` are internal and carry the token; the public
  `member.invited` payload carries none). `AuditWriter` attributes API-key
  actions to the key's human creator with `actor_type='api_key'`.
- **API keys never exceed their creator** (ADR 0008): scopes must be a subset
  of the creator's current permissions, empty scopes snapshot them, and at
  request time the key's scopes are intersected with the creator's *current*
  permissions. A key minted by a key is rooted at the human creator. Every
  key-authenticated request meters one `api_requests` unit best-effort, in its
  own transaction: a metering failure is logged and never fails the request.
- **Pricing as config** (ADR 0003). `config/plans.yaml` (verbatim from the
  reference) is validated by `src/subscriptions/catalog.ts` — unknown
  feature/metric keys, duplicate keys, price xor `custom`, overage on unlimited
  metrics — with every error reported at once, and projected into `features`,
  `metrics`, `plans`, `plan_features`, `plan_limits` by `catalog-sync.ts`
  (idempotent; removed plans are archived, never deleted; `provider_refs` and
  existing `plan_snapshot`s are never touched) at boot
  (`SYNAPSE_AUTO_SYNC_PLANS`) and as `pnpm plans:sync`. A new org gets an
  active subscription on `SYNAPSE_DEFAULT_PLAN_KEY` with a `plan_snapshot` that
  freezes purchase-time terms.
- **Entitlements are resolved, never materialised.** `src/entitlements/resolver.ts`
  is the reference's pure function: plan features/limits apply while the
  subscription is occupying (`trialing`/`active`, `past_due` under
  `SYNAPSE_GRACE_ON_PAST_DUE`), grants overlay by source priority
  (`plan < addon < beta < promo < grandfather < override < enterprise`, a
  winning `enabled=false` grant is a kill switch), and `limit:<metric>` grants
  raise caps while the plan (else the metric) still prices overage. Grants are
  an operator action (`/v1/admin/orgs/{org_id}/entitlements/*`, platform admin
  only, 404 to tenants); `@RequireFeature("…")` + `FeatureGuard` answer 403
  `feature_not_entitled` with `feature`, `current_plan`, `available_in[]`, `upgrade_url`.
- **Metering is one transaction per request.** `record` never blocks;
  `consume` inserts the `usage_events` row and increments `usage_counters` with
  one `INSERT … ON CONFLICT DO UPDATE … RETURNING` under the counter's row lock,
  so concurrent consumers serialise and a breach (402 `usage_limit_exceeded`
  with `metric`, `limit`, `used`, `upgrade_url`) rolls event, counter and
  idempotency reservation back together; `consume-batch` is all-or-nothing.
  `idempotency_key` is reserved in `usage_idempotency_keys` before the event
  is written, so a concurrent retry blocks on the primary key and replays the
  stored result (`deduplicated: true`). Gauges (`users`, `projects`,
  `storage_bytes`) are levels in the fixed `1970-01-01` bucket; a positive
  `delta` is capacity-checked, a `value` sync never refused. `users` is re-set
  after every membership change and enforced on invite (402, metric `users`).
  `usage.soft_limit_reached` fires once per metric per period.
- **Plan changes go through the billing capability table** (ADR 0004,
  `src/billing/providers.ts`): providers without `recurring_hosted` (`manual`,
  Paddle, Xendit, PayMongo) change locally — paid→paid keeps the period and
  queues an arrears proration adjustment in `pending_adjustments`
  (`src/subscriptions/proration.ts`, integer millionths, half-even fraction,
  half-up cents), free→paid starts a fresh cycle; a hosted provider (Stripe)
  without a provider subscription is 409 `checkout_required`, and with one is
  told first — the local row then follows the provider's answer.
- **Providers are a capability table plus a client** (ADR 0004). The DTOs and
  the `BillingProvider` interface live in `src/billing/providers.ts`; the five
  clients (`manual`, `stripe`, `paddle`, `xendit`, `paymongo`) are plain
  `fetch` — no vendor SDKs — with `fetchImpl` injected so tests point them at a
  local stub. `BillingProviderRegistry` refuses a hosted provider whose secret
  is unset with 409 `billing_provider_not_configured` up front. Money is
  integer minor units end to end (ADR 0006): Xendit's major-unit amounts are
  parsed as decimal *strings*, never `Math.round(float * 100)`.
- **Webhook ingest is signed over raw bytes.** `express.raw` is mounted on
  `/v1/billing/webhooks/:provider` ahead of the JSON parser, so the signature
  covers exactly what the provider signed. `provider_webhook_events` is the
  idempotency ledger: a replay answers 200 without re-applying; a `DomainError`
  from applying an event is recorded on the ledger row and still answers 200
  (a retry cannot change a deterministic rejection); anything else propagates,
  so the ledger row rolls back with the transaction and the provider retries —
  a transient database fault can never lose `invoice.paid`. The org is resolved
  through the baseline's `synapse_org_for_provider_ref` SECURITY DEFINER
  function, because under RLS the API role cannot see the row before a tenant
  is bound.
- **Invoicing is the framework's own.** Draft = the plan line at the
  purchase-time snapshot price + one overage line per metric priced by the
  ENTITLEMENT RESOLVER (so `limit:<metric>` grants shape billing exactly as
  they shape enforcement) + the `pending_adjustments` a mid-period plan change
  queued, drained on draft, with a negative subtotal carried forward as a
  credit. Every line reconciles alone: `quantity × unit_amount == amount`.
  Finalize locks the org row, stamps `INV-YYYYMM-####` and emits
  `invoice.created` plus the internal `invoice.email`. Recording a payment or
  voiding is **operator-only** (ADR 0008 — tenants get 404, never 403), and the
  org is derived from the invoice rather than a tenant header.
- **The worker adds no tables.** Each tick takes
  `pg_try_advisory_lock(hashtext('job:<name>'))` on a dedicated connection and
  skips if held; rows are claimed `FOR UPDATE SKIP LOCKED` and each event or
  renewal runs in its own savepoint. Jobs are cross-tenant, so every job
  transaction opens with `tx.bindPlatform()`. Outbox dispatch fans **public**
  events out to each org's active endpoints and runs the in-process consumers
  only after the batch is committed, so a retry cannot resend an invite or an
  invoice; internal events (invite tokens, reset links, `invoice.email`) never
  leave the process. Deliveries are signed `X-Synapse-Signature: t=…,v1=…`
  over `"<unix>.<body>"`, and endpoint secrets are Fernet-encrypted at rest
  under `SYNAPSE_SECRET_KEY` — `src/webhooks/fernet.ts` implements the format
  (AES-128-CBC + HMAC-SHA256, padded base64url) rather than picking a library,
  so an endpoint created by any implementation is deliverable by any other.
- **A webhook secret exists for exactly one response.** `POST
  /v1/webhooks/endpoints` mints `whsec_…`, encrypts it before it touches a
  column and returns it once; nothing reads it back but the worker, at
  delivery time, and the list route has no `secret` field to leak. `url` is
  parsed with WHATWG `URL` rather than `@IsUrl` (which accepts bare
  hostnames): the normalised `href` that gets stored is exactly what
  pydantic's `str(HttpUrl)` yields. Endpoint and delivery ids are org-scoped,
  so a foreign one is a 404, and retry returns any delivery to `pending` with
  its attempts cleared and due now.
- **Files: quota first, then bytes, then the row.** `storage_bytes` is a
  LEVEL, so `POST /v1/files` reserves capacity before a single byte is
  written (402 with `upgrade_url` on a breach), writes the object, then
  indexes it; a failure after the reservation releases it. Keys are
  `{org_id}/{name}` — the org prefix IS the tenant boundary for bytes, so no
  backend is ever trusted to scope a read, and traversal is refused in
  `src/storage/keys.ts`. Local disk is the default (`SYNAPSE_STORAGE_ROOT`)
  and answers 409 `presign_unsupported` in both directions; setting
  `SYNAPSE_S3_BUCKET` selects the S3-compatible backend (AWS, R2, MinIO). On
  that backend `presign-upload` reserves the quota, hands out a signed PUT and
  indexes a `pending` row; `complete` verifies size and, on a mismatch,
  releases the reservation and soft-deletes in a transaction that **commits
  before** the 409 — so a tenant is never billed for bytes that never arrived
  — and `purge_expired` does the same for uploads that were simply abandoned.
- **Flags are not entitlements.** Entitlements answer "what did this org pay
  for?" (`@RequireFeature` + `FeatureGuard`, 403 with upgrade hints); flags
  answer "is this code path on yet?" (`@RequireFlag` + `FeatureFlagGuard`,
  403 carrying the flag key). Resolution is user override → org override →
  global default, an unknown or archived flag is off, and percentage rollouts
  bucket deterministically: the first four bytes of `sha256("{flag}:{id}")`
  big-endian, modulo 10 000, in when below `BUCKETS * pct // 100`. Defining
  flags and overriding them for somebody else is an operator action (ADR
  0008), so tenants get 404 on everything but `check/{key}`.
- **Agents are governance, not execution** (ADR 0007). The whole
  `/v1/agents` family sits behind the `agents` entitlement declared once on
  the controller and enforced ahead of the permission check, `config` is
  opaque JSON owned by whatever runtime executes the agent, and delete is a
  soft delete whose slug stays taken — registry rows are billing history.
- **The audit read is just a read.** `GET /v1/audit` (permission
  `audit:read`) pages the rows `AuditWriter` has been writing since milestone
  2, newest first, filterable by `event_type` and `actor_user_id`; platform
  rows (`organization_id IS NULL`) never surface on a tenant's page.

## Run

```bash
pnpm install
pnpm build && pnpm test               # unit tests + probes (no database)
pnpm test:db                          # + the supertest journey against a real Postgres (see below)
pnpm dev                              # boot with migrations + seed + bootstrap admin
pnpm migrate                          # apply pending migrations/*.sql and exit
pnpm seed                             # permission catalog + system roles + plan catalog (idempotent) + bootstrap admin
pnpm plans:sync                       # config/plans.yaml (SYNAPSE_PLANS_FILE) → features/metrics/plans tables
pnpm worker                           # the background jobs without the HTTP listener
pnpm jobs:run-once --all              # run every job once, print `name: count`, exit
pnpm jobs:run-once dispatch_outbox deliver_webhooks
pnpm conformance:m2                   # milestone-2 modules of the reference suite → http://localhost:8090
pnpm conformance:m3                   # milestones 1–3
pnpm conformance:m4                   # milestones 1–4
pnpm conformance                      # the whole reference suite (the current gate)
```

Boot sequence (`src/bootstrap.ts`): apply `migrations/*.sql` once each (tracked
in `schema_migrations`; `SYNAPSE_MIGRATE_ON_START=false` to skip) → assert the DB
role matches the isolation mode → seed the permission catalog and the five
system roles (`SYNAPSE_SEED_ON_START=false` to skip) → sync the plan catalog
(`SYNAPSE_AUTO_SYNC_PLANS=false` to skip; an invalid catalog is logged, and
refuses to boot only in production) → create-or-promote the bootstrap platform
admin. The catalog must be synced before the first org is created: org creation
sets the `users` gauge, which needs the `users` metric.

### Worker

The seven jobs run in-process with the API by default. Set
`SYNAPSE_WORKER_ENABLED=false` on the API processes and run `pnpm worker`
instead to scale them apart, or drive them from an external scheduler with
`pnpm jobs:run-once` (which prints `name: count` per job and exits non-zero on
an unknown name or a failure). All three paths call the same `JobsService`
methods.

| Job | Cadence (UTC) | What it does |
|---|---|---|
| `dispatch_outbox` | every 5 s | publish outbox events, fan public ones out to endpoints, then run the in-process consumers |
| `deliver_webhooks` | every 15 s | POST due deliveries with `X-Synapse-Signature`, retry on the 1m/5m/30m/2h/6h ladder, `exhausted` after 6 |
| `rollup_usage` | hourly at :05 | rebuild the current period's counters from `usage_events` |
| `expire_entitlements` | hourly at :10 | revoke lapsed grants and emit `entitlement.expired` |
| `advance_recurring_billing` | hourly at :20 | invoice the ended period for locally billed subscriptions, roll the period forward |
| `ensure_partitions` | daily 03:30 | create `usage_events_yYYYYmMM` through +3 months |
| `purge_expired` | daily 03:40 | retention: deliveries 30 d (`exhausted` 90 d), outbox 7 d, idempotency keys 90 d, audit `SYNAPSE_AUDIT_RETENTION_DAYS` |

```bash
SYNAPSE_DATABASE_URL=postgresql://synapse:synapse@localhost:5434/synapse_node \
  pnpm jobs:run-once --all
```

### Platform admin bootstrap

Operator journeys (org suspension, and later grants/payments) need a platform
admin. Set both variables and the account is created with that password on
first boot, or promoted to platform admin if it already exists (an existing
password is never rewritten):

```bash
SYNAPSE_BOOTSTRAP_ADMIN_EMAIL=operator@platform.example.com \
SYNAPSE_BOOTSTRAP_ADMIN_PASSWORD=operator-password-12345 \
PORT=8090 SYNAPSE_DATABASE_URL=postgresql://synapse:synapse@localhost:5434/synapse_node pnpm dev
```

The same credentials go to the conformance suite as
`SYNAPSE_CONFORMANCE_ADMIN_EMAIL` / `SYNAPSE_CONFORMANCE_ADMIN_PASSWORD`.

### Conformance

With the server on `:8090`:

```bash
cd ../synapse-saas && \
SYNAPSE_CONFORMANCE_API_URL=http://localhost:8090 \
SYNAPSE_CONFORMANCE_ADMIN_EMAIL=operator@platform.example.com \
SYNAPSE_CONFORMANCE_ADMIN_PASSWORD=operator-password-12345 \
uv run pytest tests/conformance -m "" --no-cov -q -p no:cacheprovider
```

Expected today: **51 passed** — every module, no permitted failures. The
server needs `SYNAPSE_BILLING_PROVIDER=manual`, the bootstrap-admin variables
below, and a writable `SYNAPSE_STORAGE_ROOT` (the file journeys run on the
local-disk backend; the S3 path is covered by `pnpm test:db`).

### Tests

- `pnpm test` — unit tests for the pure logic (permission catalog + role
  ordering, problem documents, argon2/JWT helpers, ids/slugs, events, settings,
  tenant resolution, the milestone-3 transliterations: plan catalog validation,
  subscription state machine, proration, entitlement resolver,
  `UsageService.checkAgainst`, and the milestone-4 ones: the webhook signature
  matrix for all five providers (valid, tampered body, wrong secret, stale
  timestamp, missing header, unconfigured secret), `translateWebhook` fixtures
  per provider, exact decimal ↔ minor-unit conversion, the provider clients
  against a local stub HTTP server, the invoice state machine and numbering,
  overage/adjustment line construction, PDF bytes, the Fernet codec — including
  a token minted by the reference's `cryptography.fernet` — the outbound
  signature, both retry ladders and `jobs run-once` selection, and the
  milestone-5 ones: flag bucketing against vectors computed by the reference's
  `bucket_of` plus rollout monotonicity and spread, storage key validation and
  traversal, both backends' put/get/head/delete, the presigned URL shape, the
  `whsec_` secret and the `HttpUrl` acceptance set, and the endpoint read that
  must never carry a secret) and the probe controller. No database needed; the
  DB-backed suites are skipped.
- `pnpm test:db` — additionally runs the supertest journeys in
  `test/integration/` (shared bootstrap in `harness.ts`): `journey.test.ts`
  (register → org → invite → accept → roles → API keys → operator suspension →
  password reset → logout) and `monetization.test.ts` (plan catalog + idempotent
  sync → free plan consume until 402 → soft-limit event → trial → paid limits →
  cancel/resume → plan change with proration → idempotent record/consume incl.
  concurrent retries → batch rollback → gauges → seat limit → operator grants
  and kill switch → key auth meters `api_requests` → 10 parallel consumes never
  overshoot a 3-slot limit → feature gate) and `billing.test.ts` (manual
  checkout → confirm → draft → finalize → PDF → operator pay/void → spend and
  revenue reports; overage lines from metered usage; a mid-period plan change
  landing as a proration line and draining; outbox dispatch fanning out to a
  directly inserted endpoint row with a signature verified against the
  Fernet-decrypted secret; retry → `exhausted`; dead-letter after 8 attempts;
  internal events never reaching deliveries; webhook replay 200-no-op,
  unsigned 400 with no ledger row, a business rejection recorded + 200, an
  infrastructure failure rolling the ledger row back; recurring billing
  renewing an ended period; invite/reset/invoice mail captured through the
  notifier seam with the PDF attached; `ensure_partitions` creating +3 months
  and `purge_expired` honouring retention), `platform.test.ts` (endpoint
  secret shown once and stored Fernet-encrypted → list masked → a delivery
  produced by a real `member.invited` → filter → retry → delete cascading its
  deliveries; file upload → list → download bytes → gauge up → delete → gauge
  down, the 402 before a byte is written, both presign 409s and the
  `storage_error` family; flag override layering, upsert, duplicate/unknown/
  scope-less rejections and rollout determinism; the audit page with filters
  and API-key attribution; the agent gate → grant → CRUD → slug-reuse 409 with
  the exact event and audit vocabulary each mutation leaves) and
  `storage-s3.test.ts` (the presigned half against `StubS3Server`, an S3-shaped
  object store over plain HTTP: reserve → presign → PUT → complete → ready,
  complete without a PUT answering 409 with the reservation released, a size
  mismatch, and `purge_expired` reclaiming an abandoned upload) against
  `SYNAPSE_TEST_DATABASE_URL`
  (default `postgresql://synapse:synapse@localhost:5434/synapse_node_test`).
  Every table of that database is truncated first — never point it at data you
  care about. `SYNAPSE_TEST_TENANT_ISOLATION=app_and_rls` runs them with RLS
  bindings on (requires connecting as an RLS-subject role).

## Environment

Same `SYNAPSE_*` names as the reference wherever the concept exists (the
reference's `postgresql+asyncpg://` DSN form is accepted):

| Variable | Default | Purpose |
|---|---|---|
| `SYNAPSE_ENV` | `development` | `production` enforces the guardrails (no dev secret) |
| `SYNAPSE_SECRET_KEY` | dev default | HS256 key for access tokens (shared with the reference ⇒ interchangeable tokens) |
| `SYNAPSE_DATABASE_URL` | `postgresql://synapse:synapse@localhost:5433/synapse` | Postgres DSN (`SYNAPSE_DB_POOL_SIZE`, default 10) |
| `SYNAPSE_TENANT_ISOLATION` | `app` | `app` or `app_and_rls` (RLS GUCs bound per transaction) |
| `SYNAPSE_BILLING_PROVIDER` / `SYNAPSE_IDENTITY_PROVIDER` | `manual` / `local` | reported by `/v1/meta`; the billing provider's capabilities decide how `POST /v1/subscription/change` behaves |
| `SYNAPSE_BILLING_CURRENCY` | `PHP` | ISO-4217 currency for billing customers and invoices |
| `SYNAPSE_STRIPE_SECRET_KEY` / `SYNAPSE_STRIPE_WEBHOOK_SECRET` | `` | Stripe API key (Basic auth) and the `Stripe-Signature` secret |
| `SYNAPSE_PADDLE_SECRET_KEY` / `SYNAPSE_PADDLE_WEBHOOK_SECRET` | `` | Paddle Billing key and the `Paddle-Signature` secret |
| `SYNAPSE_XENDIT_SECRET_KEY` / `SYNAPSE_XENDIT_WEBHOOK_TOKEN` | `` | Xendit key and the static `X-Callback-Token` |
| `SYNAPSE_PAYMONGO_SECRET_KEY` / `SYNAPSE_PAYMONGO_WEBHOOK_SECRET` | `` | PayMongo key and the `Paymongo-Signature` secret |
| `SYNAPSE_MANUAL_WEBHOOK_TOKEN` | `` | shared token for `POST /v1/billing/webhooks/manual` (`X-Manual-Token`); unset ⇒ every call is 400 |
| `SYNAPSE_MANUAL_PAY_TO_INSTRUCTIONS` | `` | pay-to text printed on unpaid invoice PDFs |
| `SYNAPSE_NOTIFIER` | `smtp` | `noop` logs instead of sending (also the default when no SMTP host is set) |
| `SYNAPSE_SMTP_HOST` / `SYNAPSE_SMTP_PORT` / `SYNAPSE_SMTP_FROM` | ``, `1025`, `synapse@localhost` | the relay |
| `SYNAPSE_SMTP_USERNAME` / `SYNAPSE_SMTP_PASSWORD` / `SYNAPSE_SMTP_TLS` | ``, ``, `none` | AUTH credentials and transport security (`none`\|`starttls`\|`ssl`); AUTH over plaintext is refused |
| `SYNAPSE_STORAGE_ROOT` | `.storage` | local-disk object root; used whenever no bucket is configured |
| `SYNAPSE_S3_BUCKET` | `` | set it to select the S3-compatible backend (unlocks presigned URLs) |
| `SYNAPSE_S3_ENDPOINT_URL` | `` | custom endpoint for MinIO/R2 (also switches to path-style buckets); empty ⇒ AWS |
| `SYNAPSE_S3_REGION` | `us-east-1` | SigV4 region |
| `SYNAPSE_S3_ACCESS_KEY_ID` / `SYNAPSE_S3_SECRET_ACCESS_KEY` | `` | credentials; unset falls back to the AWS default chain |
| `SYNAPSE_STORAGE_PRESIGN_SECONDS` | `3600` | presigned URL lifetime; `purge_expired` releases abandoned uploads at twice this age |
| `SYNAPSE_WORKER_ENABLED` | `true` | run the job cadence in-process with the API |
| `SYNAPSE_AUDIT_RETENTION_DAYS` | `365` | how long `purge_expired` keeps audit rows |
| `SYNAPSE_PLANS_FILE` | `config/plans.yaml` | the plan catalog (pricing-as-config source of truth) |
| `SYNAPSE_AUTO_SYNC_PLANS` | `true` | sync the catalog into the database at boot |
| `SYNAPSE_DEFAULT_PLAN_KEY` | `free` | plan of the subscription bootstrapped on org creation, and the entitlement fallback without one |
| `SYNAPSE_GRACE_ON_PAST_DUE` | `true` | `past_due` subscriptions keep their plan features |
| `SYNAPSE_WEB_ORIGIN`, `SYNAPSE_WEB_ORIGINS` | `http://localhost:3000`, `` | CORS origins (CSV or JSON list) |
| `SYNAPSE_COOKIE_SECURE` | derived | refresh-cookie `Secure` flag (default: production or https origin) |
| `SYNAPSE_ACCESS_TOKEN_TTL_MINUTES` | `15` | access token lifetime |
| `SYNAPSE_REFRESH_TOKEN_TTL_DAYS` | `30` | refresh token lifetime |
| `SYNAPSE_REFRESH_REUSE_GRACE_SECONDS` | `10` | replay window for a rotated refresh token before the chain is revoked |
| `SYNAPSE_MIGRATE_ON_START` / `SYNAPSE_SEED_ON_START` | `true` | boot-time migrations / seed |
| `SYNAPSE_BOOTSTRAP_ADMIN_EMAIL` / `SYNAPSE_BOOTSTRAP_ADMIN_PASSWORD` | unset | create-or-promote the platform admin at boot |
| `PORT` | `8080` | listen port |

## Layout

```
src/
  main.ts                 HTTP wiring (CLS middleware first, body parsers, cookies, CORS), boot
  bootstrap.ts            migrations → isolation check → seed → bootstrap admin
  app.module.ts           ClsModule + route-family modules; global problem filter + validation pipe
  api/                    probes + /v1/meta
  core/                   config (zod), errors (problem documents), problem.filter, request-context (CLS),
                          db/ (Database + Tx with RLS GUCs, migration runner), ids, events, outbox, audit,
                          security (argon2id, HS256, opaque tokens), pagination, validation
  identity/               /v1/auth: DTOs, users + tokens repositories, service, AuthGuard (JWT + sk_ keys),
                          refresh cookie, platform-admin bootstrap
  tenancy/                /v1/orgs, /v1/memberships: repositories, service, TenantGuard, PlatformAdminGuard
  authorization/          the RBAC engine (catalog, roles repository, service, PermissionsGuard, seed)
                          + the /v1/roles + /v1/permissions route family (RolesModule)
  api-keys/               /v1/api-keys: repository, service, controller
  subscriptions/          catalog (plans.yaml → validated model), catalog-sync (→ tables), state-machine,
                          proration, plans + subscriptions repositories, service (engine: SubscriptionsModule)
                          + the /v1/plans + /v1/subscription* route family (SubscriptionsRoutesModule)
  entitlements/           resolver (pure), repository, service, FeatureGuard/@RequireFeature (EntitlementsModule)
                          + /v1/entitlements and /v1/admin/orgs/{org_id}/entitlements* (EntitlementsRoutesModule)
  usage/                  repository (counters, events, idempotency, gauges), service (UsageModule)
                          + /v1/usage/* (UsageRoutesModule)
  billing/                providers.ts (capability table + DTOs + interface), providers/ (manual, stripe,
                          paddle, xendit, paymongo over injected fetch), registry, billing-customers
                          repository, BillingService (customers, checkout, portal, plan change),
                          invoicing/ (repository, numbering + state machine, engine, pdfkit renderer),
                          reporting/, webhooks/ (raw-body ingest + idempotency ledger) — engine:
                          BillingModule, routes: BillingRoutesModule
  webhooks/               outbound delivery: envelope + ladders, Fernet codec, signer, deliveries
                          repository, WebhookDeliveryService (WebhooksModule)
                          + endpoints repository, WebhooksService, /v1/webhooks/* (WebhooksRoutesModule)
  storage/                keys (org-scoped validation), backend interface, local-disk + S3 backends,
                          files repository, FilesService, /v1/files (StorageModule)
  feature-flags/          buckets (deterministic rollouts), flags repository + service, @RequireFlag
                          guard, /v1/feature-flags (FeatureFlagsModule)
  agents/                 repository, service, /v1/agents behind @RequireFeature("agents") (AgentsModule)
  audit/                  repository + /v1/audit over the rows core/audit.ts writes (AuditRoutesModule)
  notifications/          Notifier seam, SMTP + Noop transports, outbox-event handlers (NotificationsModule)
  worker/                 advisory lock, outbox repository, JobsService (the seven jobs), the @Cron/@Interval
                          cadence (WorkerModule), and worker.ts (standalone entrypoint)
  cli/                    migrate, seed, plans-sync, jobs-run-once
config/plans.yaml             the plan catalog, verbatim from the reference
migrations/001_baseline.sql   = contracts/schema-v1.sql (applied by the raw-SQL runner)
contracts/                    snapshot of the reference contract (openapi, events, problems, changelog)
test/unit, test/integration   vitest (SWC for decorator metadata)
```

Module graph (acyclic): `Core ← Subscriptions ← Entitlements ← Usage ← Authorization ← Tenancy ← Billing ← Notifications ← Worker`,
with `{Roles, ApiKeys, Identity, Agents, Storage, FeatureFlags, *RoutesModules}`
on top and `Webhooks` beside `Core`. Engines never import route modules;
`Identity` imports `Usage` to meter API keys; `Storage` imports `Usage` for the
`storage_bytes` gauge and `Entitlements` for the `api_access` gate; `Worker`
imports `Usage` plus the files repository so `purge_expired` can hand back the
bytes an abandoned presigned upload reserved; `Billing` never imports
`Notifications` (mail is a post-commit consumer the worker drives).

## Where this port deliberately differs from the reference server

The reference adopted this port's milestone-2 findings in `synapse-saas@4de2026`
(problem documents for unknown routes and wrong methods, `switch-org` 200 in the
contract, 409 `conflict` for duplicate invites and role keys, invite `role_keys`
and organization name, IP-literal hosts, `check_function_bodies` in the
baseline), so observable behaviour is aligned. Remaining differences are
internal: entitlements and feature flags are not cached (resolved per request,
with the reference's invalidation points marked).

Three places where this port is deliberately *stricter* than the reference, all
invisible to the contract:

- **Xendit amounts.** The reference does `int(float(amount) * 100)`
  (`billing/providers/xendit_provider.py:181`, and again at `:209`), which
  truncates `0.29` to 28 centavos. This port parses the decimal string, so `0.29` is 29 — ADR 0006
  says money is integer minor units end to end.
- **`verifyWebhook` always rejects through a promise** rather than throwing
  synchronously, so a caller cannot miss a refusal by forgetting to await.
- **`GET /v1/webhooks/endpoints` orders by `created_at`.** The reference's
  `WebhookService.list_endpoints` (`webhooks/service.py:81`) has no `ORDER BY`,
  so the rows it hands to `paginate_in_memory` arrive in whatever order
  Postgres returns — pages can repeat or skip an endpoint. The order is
  unspecified by the contract, so imposing one breaks nothing.

Three things the contract and the reference server disagree about, left as the
reference has them and reported upstream rather than "fixed" here (ADR 0012):

- **`contracts/events.json` advertises five events nothing emits.**
  `file.uploaded`, `file.deleted`, `webhook.endpoint_created`,
  `webhook.endpoint_updated` and `webhook.endpoint_deleted` are in the public
  catalog and defined in `core/events.py:55-56,64-66`, but `storage/router.py`
  and `webhooks/service.py` contain no `append_outbox` call — a tenant
  subscribing to them receives nothing. Neither do those two routers write
  audit rows, so uploading or deleting a file and creating or deleting a
  webhook endpoint leave no trail on `GET /v1/audit`. This port matches the
  server, not the catalog.
- **A flag override may carry both scopes, and the org half is then ignored.**
  `OverrideCreate._require_scope` (`feature_flags/schemas.py:42`) only rejects
  an override with *neither* `organization_id` nor `user_id`; with both,
  `FeatureFlagService._override` (`service.py:211`) matches on `user_id`
  alone, so the row is written and read back as a user override while its
  `organization_id` column says otherwise.
- **`set_override` answers 404 `feature_flag_not_found` for a missing scope**
  (`service.py:151`) — a validation problem wearing a not-found title. The
  route can never reach it (the schema rejects first with 422), so the port
  keeps both behaviours exactly where the reference puts them.

Package: `@synapse-saas/server`. Repository: `allandanos/synapse-saas-node`. Licence: Apache-2.0.
