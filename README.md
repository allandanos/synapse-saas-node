# synapse-saas-node

NestJS 11 / TypeScript implementation of the **Synapse SaaS Framework contract
v1**. The reference implementation, the contract, and the acceptance suite live
in [`synapse-saas`](../synapse-saas) — see its
[ADR 0012](../synapse-saas/docs/adr/0012-polyglot-ports-contract-first.md) and
[porting guide](../synapse-saas/ports/README.md).

**Contract pinned at:** `synapse-saas@820ce2f` (`contracts/` is a snapshot of
that commit; re-copy when the reference's `contracts/CHANGELOG.md` gains an entry).

## Status

| Milestone | Scope | State |
|---|---|---|
| 1 | pure logic + core + probes/`/v1/meta` | **done** — `/healthz`, `/readyz`, `/v1/meta`, typed settings, problem documents, request context, DB + RLS GUCs, raw-SQL migrations, outbox + audit writers |
| 2 | identity, tenancy, authorization (RBAC), API keys | **done** — `test_meta_and_health`, `test_auth`, `test_tenancy`, `test_authorization`, `test_api_keys` pass (`test_key_lifecycle` stops at its `POST /v1/usage/consume` step, a milestone 3 route) |
| 3 | subscriptions, entitlements, usage | — |
| 4 | billing, invoicing, worker | — |
| 5 | webhooks, files, flags, audit, agents | — |
| 6 | console parity (Playwright) | — |
| 7 | OIDC + OpenFGA, hardening | — |

A milestone is done when the corresponding `tests/conformance` modules pass
against this server (`pnpm conformance`).

Deferred with milestone 3 (they need the plan catalog and usage meters): the
default-plan subscription bootstrapped on org creation, the `users` seat gauge
and invite seat limit, and per-request `api_requests` metering for API keys.
Redis-backed caching and auth rate limiting arrive with the worker milestone.

## Stack

NestJS 11 · `nestjs-cls` (AsyncLocalStorage request context: request id, user,
tenant) · `pg` with small hand-written repositories and **raw SQL migrations**
(`migrations/001_baseline.sql` = `contracts/schema-v1.sql`; Prisma cannot express
the partial indexes / BRIN / partitioning / RLS policies this schema uses, and an
ORM's generated DDL is ruled out by ADR 0012) · `class-validator` DTOs →
`validation_failed` problem documents · `@node-rs/argon2` (argon2id, same
parameters as the reference) · `jsonwebtoken` (HS256, same claims) · zod-typed
settings · Vitest + supertest.

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
  permissions. A key minted by a key is rooted at the human creator.

## Run

```bash
pnpm install
pnpm build && pnpm test               # unit tests + probes (no database)
pnpm test:db                          # + the supertest journey against a real Postgres (see below)
pnpm dev                              # boot with migrations + seed + bootstrap admin
pnpm migrate                          # apply pending migrations/*.sql and exit
pnpm seed                             # permission catalog + system roles (idempotent) + bootstrap admin
pnpm conformance:m2                   # milestone-2 modules of the reference suite → http://localhost:8090
pnpm conformance                      # the whole reference suite
```

Boot sequence (`src/bootstrap.ts`): apply `migrations/*.sql` once each (tracked
in `schema_migrations`; `SYNAPSE_MIGRATE_ON_START=false` to skip) → assert the DB
role matches the isolation mode → seed the catalog and the five system roles
(`SYNAPSE_SEED_ON_START=false` to skip) → create-or-promote the bootstrap
platform admin.

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
uv run pytest tests/conformance/test_meta_and_health.py tests/conformance/test_auth.py \
  tests/conformance/test_tenancy.py tests/conformance/test_authorization.py \
  tests/conformance/test_api_keys.py -m "" --no-cov -q -p no:cacheprovider
```

### Tests

- `pnpm test` — unit tests for the pure logic (permission catalog + role
  ordering, problem documents, argon2/JWT helpers, ids/slugs, events, settings,
  tenant resolution) and the probe controller. No database needed; the
  DB-backed suite is skipped.
- `pnpm test:db` — additionally runs `test/integration/journey.test.ts`
  (register → org → invite → accept → roles → API keys → operator suspension →
  password reset → logout) over supertest against
  `SYNAPSE_TEST_DATABASE_URL` (default
  `postgresql://synapse:synapse@localhost:5434/synapse_node_test`). Every table
  of that database is truncated first — never point it at data you care about.
  `SYNAPSE_TEST_TENANT_ISOLATION=app_and_rls` runs it with RLS bindings on
  (requires connecting as an RLS-subject role).

## Environment

Same `SYNAPSE_*` names as the reference wherever the concept exists (the
reference's `postgresql+asyncpg://` DSN form is accepted):

| Variable | Default | Purpose |
|---|---|---|
| `SYNAPSE_ENV` | `development` | `production` enforces the guardrails (no dev secret) |
| `SYNAPSE_SECRET_KEY` | dev default | HS256 key for access tokens (shared with the reference ⇒ interchangeable tokens) |
| `SYNAPSE_DATABASE_URL` | `postgresql://synapse:synapse@localhost:5433/synapse` | Postgres DSN (`SYNAPSE_DB_POOL_SIZE`, default 10) |
| `SYNAPSE_TENANT_ISOLATION` | `app` | `app` or `app_and_rls` (RLS GUCs bound per transaction) |
| `SYNAPSE_BILLING_PROVIDER` / `SYNAPSE_IDENTITY_PROVIDER` | `manual` / `local` | reported by `/v1/meta` |
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
  cli/                    migrate, seed
migrations/001_baseline.sql   = contracts/schema-v1.sql (applied by the raw-SQL runner)
contracts/                    snapshot of the reference contract (openapi, events, problems, changelog)
test/unit, test/integration   vitest (SWC for decorator metadata)
```

Module graph (acyclic): `Core ← Authorization ← Tenancy ← {Roles, ApiKeys, Identity}`.

## Where this port deliberately differs from the reference server

Observable behaviour follows the reference; these are the places where a port
should not reproduce an accident (all outside what `tests/conformance` checks):

- Unknown routes answer an RFC 7807 `not_found` problem (the reference returns
  FastAPI's bare `{"detail": "Not Found"}`).
- A duplicate invite email or duplicate custom-role key answers `409 conflict`
  (the reference surfaces the unique-constraint violation as a 500).
- The invite response carries the membership's actual `role_keys` (the
  reference returns `[]` because the relationship is read before the flush).
- `member.invited` / `member.invite_email` outbox payloads carry the real
  organization name (the reference's router leaves the default
  `"your organization"`).
- Tenant resolution ignores IP-literal hosts (the reference would try `127`
  as a subdomain slug when addressed by IP).

Package: `@synapse-saas/server`. Repository: `allandanos/synapse-saas-node`. Licence: Apache-2.0.
