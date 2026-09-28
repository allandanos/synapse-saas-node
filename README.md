# synapse-saas-node

NestJS 11 / TypeScript implementation of the **Synapse SaaS Framework contract
v1**. The reference implementation, the contract, and the acceptance suite live
in [`synapse-saas`](../synapse-saas) — see its
[ADR 0012](../synapse-saas/docs/adr/0012-polyglot-ports-contract-first.md) and
[porting guide](../synapse-saas/ports/README.md).

**Contract pinned at:** `synapse-saas@1184245` (`contracts/` is a snapshot of
that commit; re-copy when the reference's `contracts/CHANGELOG.md` gains an entry).

## Status

| Milestone | Scope | State |
|---|---|---|
| 1 | pure logic + core + probes/`/v1/meta` | **done** — `/healthz`, `/readyz`, `/v1/meta`, typed settings, problem documents, request context, DB + RLS GUCs, raw-SQL migrations, outbox + audit writers |
| 2 | identity, tenancy, authorization (RBAC), API keys | **done** — `test_meta_and_health`, `test_problem_documents`, `test_auth`, `test_tenancy`, `test_authorization`, `test_api_keys` pass |
| 3 | subscriptions, entitlements, usage | **done** — `test_subscriptions` (4/4), `test_usage_and_entitlements` (7/8: `test_feature_gate_problem_shape` needs `GET /v1/agents`, a milestone-5 route), `test_api_keys` fully, no milestone-2 regression (`pnpm conformance:m3`) |
| 4 | billing, invoicing, worker | — |
| 5 | webhooks, files, flags, audit, agents | — |
| 6 | console parity (Playwright) | — |
| 7 | OIDC + OpenFGA, hardening | — |

A milestone is done when the corresponding `tests/conformance` modules pass
against this server (`pnpm conformance`).

Deferred to milestone 4: the billing provider clients (checkout, webhooks,
invoices, and the "hosted provider with an existing provider subscription"
branch of `POST /v1/subscription/change`, refused today with 409
`billing_provider_not_configured` at the marked seam in
`src/billing/billing.service.ts`), `usage_events` partition maintenance, the
Redis-backed entitlement cache (entitlements are computed per request behind
`EntitlementsService.effectiveForOrg`), and auth rate limiting.

## Stack

NestJS 11 · `nestjs-cls` (AsyncLocalStorage request context: request id, user,
tenant) · `pg` with small hand-written repositories and **raw SQL migrations**
(`migrations/001_baseline.sql` = `contracts/schema-v1.sql`; Prisma cannot express
the partial indexes / BRIN / partitioning / RLS policies this schema uses, and an
ORM's generated DDL is ruled out by ADR 0012) · `class-validator` DTOs →
`validation_failed` problem documents · `@node-rs/argon2` (argon2id, same
parameters as the reference) · `jsonwebtoken` (HS256, same claims) · zod-typed
settings and plan catalog (`yaml` parses `config/plans.yaml`) · Vitest + supertest.

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
  without a provider subscription is 409 `checkout_required`.

## Run

```bash
pnpm install
pnpm build && pnpm test               # unit tests + probes (no database)
pnpm test:db                          # + the supertest journey against a real Postgres (see below)
pnpm dev                              # boot with migrations + seed + bootstrap admin
pnpm migrate                          # apply pending migrations/*.sql and exit
pnpm seed                             # permission catalog + system roles + plan catalog (idempotent) + bootstrap admin
pnpm plans:sync                       # config/plans.yaml (SYNAPSE_PLANS_FILE) → features/metrics/plans tables
pnpm conformance:m2                   # milestone-2 modules of the reference suite → http://localhost:8090
pnpm conformance:m3                   # milestones 1–3 (the current gate)
pnpm conformance                      # the whole reference suite
```

Boot sequence (`src/bootstrap.ts`): apply `migrations/*.sql` once each (tracked
in `schema_migrations`; `SYNAPSE_MIGRATE_ON_START=false` to skip) → assert the DB
role matches the isolation mode → seed the permission catalog and the five
system roles (`SYNAPSE_SEED_ON_START=false` to skip) → sync the plan catalog
(`SYNAPSE_AUTO_SYNC_PLANS=false` to skip; an invalid catalog is logged, and
refuses to boot only in production) → create-or-promote the bootstrap platform
admin. The catalog must be synced before the first org is created: org creation
sets the `users` gauge, which needs the `users` metric.

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
uv run pytest tests/conformance/test_meta_and_health.py tests/conformance/test_problem_documents.py \
  tests/conformance/test_auth.py tests/conformance/test_tenancy.py tests/conformance/test_authorization.py \
  tests/conformance/test_api_keys.py tests/conformance/test_subscriptions.py \
  tests/conformance/test_usage_and_entitlements.py -m "" --no-cov -q -p no:cacheprovider
```

Expected today: 36 passed, 1 failed — `test_feature_gate_problem_shape` gets a
404 from `GET /v1/agents` (milestone 5) instead of the 403 feature gate.

### Tests

- `pnpm test` — unit tests for the pure logic (permission catalog + role
  ordering, problem documents, argon2/JWT helpers, ids/slugs, events, settings,
  tenant resolution, and the milestone-3 transliterations: plan catalog
  validation, subscription state machine, proration, entitlement resolver,
  `UsageService.checkAgainst`) and the probe controller. No database needed;
  the DB-backed suites are skipped.
- `pnpm test:db` — additionally runs the supertest journeys in
  `test/integration/` (shared bootstrap in `harness.ts`): `journey.test.ts`
  (register → org → invite → accept → roles → API keys → operator suspension →
  password reset → logout) and `monetization.test.ts` (plan catalog + idempotent
  sync → free plan consume until 402 → soft-limit event → trial → paid limits →
  cancel/resume → plan change with proration → idempotent record/consume incl.
  concurrent retries → batch rollback → gauges → seat limit → operator grants
  and kill switch → key auth meters `api_requests` → 10 parallel consumes never
  overshoot a 3-slot limit → feature gate) against `SYNAPSE_TEST_DATABASE_URL`
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
| `SYNAPSE_BILLING_CURRENCY` | `PHP` | ISO-4217 currency for billing (milestone 4 customers) |
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
  billing/                provider capability table, BillingService.changePlan (hosted branch = milestone-4 seam)
  cli/                    migrate, seed, plans-sync
config/plans.yaml             the plan catalog, verbatim from the reference
migrations/001_baseline.sql   = contracts/schema-v1.sql (applied by the raw-SQL runner)
contracts/                    snapshot of the reference contract (openapi, events, problems, changelog)
test/unit, test/integration   vitest (SWC for decorator metadata)
```

Module graph (acyclic): `Core ← Subscriptions ← Entitlements ← Usage ← Authorization ← Tenancy ← {Roles, ApiKeys, Identity, Billing, *RoutesModules}`
(engines never import route modules; `Identity` imports `Usage` to meter API keys).

## Where this port deliberately differs from the reference server

The reference adopted this port's milestone-2 findings in `synapse-saas@4de2026`
(problem documents for unknown routes and wrong methods, `switch-org` 200 in the
contract, 409 `conflict` for duplicate invites and role keys, invite `role_keys`
and organization name, IP-literal hosts, `check_function_bodies` in the
baseline), so observable behaviour is aligned. Remaining differences are
internal: entitlements are not cached (computed per request), and the
hosted-provider plan change is refused at its seam until the provider clients
exist (milestone 4) rather than calling a provider.

Package: `@synapse-saas/server`. Repository: `allandanos/synapse-saas-node`. Licence: Apache-2.0.
