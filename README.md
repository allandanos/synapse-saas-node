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
| 1 | pure logic + core + probes/`/v1/meta` | **started** — `/healthz`, `/readyz`, `/v1/meta`, typed settings, baseline SQL |
| 2 | identity, tenancy, authorization | — |
| 3 | subscriptions, entitlements, usage | — |
| 4 | billing, invoicing, worker | — |
| 5 | webhooks, files, flags, audit, agents | — |
| 6 | console parity (Playwright) | — |
| 7 | OIDC + OpenFGA, hardening | — |

A milestone is done when the corresponding `tests/conformance` modules pass
against this server (`pnpm conformance`).

## Stack

NestJS 11 · `nestjs-cls` (AsyncLocalStorage request context: request id, user,
tenant) · `pg` + TypeORM 0.3 for entities with **raw SQL migrations**
(`migrations/001_baseline.sql` = `contracts/schema-v1.sql`; Prisma cannot express
the partial indexes / BRIN / partitioning this schema uses) · `class-validator`
· zod-typed settings · Vitest + supertest · Testcontainers for DB-backed tests.

## Run

```bash
pnpm install
pnpm build && pnpm test          # slice tests (no database)
pnpm dev                         # against the reference dev stack's Postgres on :5433
pnpm conformance                 # reference suite → http://localhost:8080
```

Environment: `SYNAPSE_DATABASE_URL` (the reference's `postgresql+asyncpg://` form
is accepted), `SYNAPSE_BILLING_PROVIDER`, `SYNAPSE_IDENTITY_PROVIDER`,
`SYNAPSE_TENANT_ISOLATION`, `PORT`.

## Layout

```
src/
  main.ts, app.module.ts
  core/        config, problem-document filter, CLS context, DB + RLS GUCs, cache, outbox  (milestone 1)
  api/         controllers, one module per route family                                    (milestones 1–5)
migrations/001_baseline.sql
contracts/     snapshot of the reference contract (openapi, events, problems, changelog)
```

Package: `@synapse-saas/server`. Repository: `allandanos/synapse-saas-node`. Licence: Apache-2.0.
