# Milestone 5 — webhook routes, files, feature flags, audit, agents

Planned by the coordinator against the reference at `synapse-saas@cd55a53`.
Every section names the reference file that holds the exact behaviour; read
it before writing the port's version. The reference server is the oracle;
report any disagreement between it, the contract and the tests instead of
"fixing" it here.

## Gate

The **entire** conformance suite green against this server — every module,
no permitted failures:

```
cd /Users/allan/workspace/100ai/synapse-saas && SYNAPSE_CONFORMANCE_API_URL=<port url> \
SYNAPSE_CONFORMANCE_ADMIN_EMAIL=operator@platform.example.com \
SYNAPSE_CONFORMANCE_ADMIN_PASSWORD=operator-password-12345 \
uv run pytest tests/conformance -m "" --no-cov -q -p no:cacheprovider
```

New modules this milestone: `test_webhooks.py`, `test_files.py`,
`test_feature_flags.py`, `test_agents.py`, `test_audit.py`, plus
`test_usage_and_entitlements.py::test_feature_gate_problem_shape` (it hits
`GET /v1/agents` and expects the 403 gate, then 200 after a grant). Read all
five test modules first — they are the precise oracle for shapes and status
codes. Milestones 1–4 must not regress.

## 0. Re-pin the contract

Copy `contracts/openapi-v1.json`, `events.json`, `problems.json`,
`CHANGELOG.md`, `schema-v1.sql` from the reference at `cd55a53`; bump the
README pin. Behaviour changes since the last pin (mirror them): invoice
emails resolve their recipient through billing customer → `settings.
billing_email` → org owner (`notifications/handlers.py::_recipient_in`).

## 1. Webhook management routes — `webhooks/router.py`, `webhooks/service.py`, `webhooks/schemas.py`

The delivery engine, Fernet secrets and signing already exist from milestone
4; this is routes over that machinery. Permission `webhook:manage` on every
route; rows are org-scoped (cross-tenant → 404).

- `POST /v1/webhooks/endpoints {url, events[], description?}` → 201
  `WebhookEndpointCreated` = `WebhookEndpointRead {id, url, description,
  events, is_active, created_at}` **plus `secret`** (`whsec_…`, shown exactly
  once; stored Fernet-encrypted). `url` is validated as an absolute HTTP(S)
  URL → 422 `validation_failed` otherwise. Empty `events` means every public
  event. Audit + `webhook.endpoint_created`.
- `GET /v1/webhooks/endpoints` → paged (`X-Total-Count`), never the secret.
- `DELETE /v1/webhooks/endpoints/{id}` → 204; unknown/foreign → 404.
- `GET /v1/webhooks/deliveries?endpoint_id=` → paged
  `WebhookDeliveryRead {id, endpoint_id, event_type, status, attempts,
  max_attempts, next_attempt_at, last_response_code, last_error,
  delivered_at, created_at}`; the filter is optional.
- `POST /v1/webhooks/deliveries/{id}/retry` → resets the delivery to
  `pending` with `next_attempt_at = now` (read `retry_delivery` for what it
  allows — exhausted/failed only?); unknown id → 404 (the conformance test
  retries an *endpoint* id and expects 404).
- Docs: `docs/webhooks.md` (signing, retry ladder, event catalog).

## 2. Files — `storage/{backend,models,router,schemas}.py`, `docs/file-storage.md`

- Table `stored_files` (baseline): `key`, `name`, `content_type`,
  `size_bytes`, `status` pending|ready, `created_by_user_id`, `deleted_at`.
  `scoped_key(org_id, name) = "{org_id}/{name}"` validated by
  `^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,500}$` and the org prefix (`validate_key`).
- Backends behind one interface (`put/get/delete/presign_get/presign_put/
  head`, `supports_presigned_upload`): **local disk** under
  `SYNAPSE_STORAGE_ROOT` (default `.storage`; no presigned URLs) and
  **S3-compatible** when `SYNAPSE_S3_BUCKET` is set (`SYNAPSE_S3_ENDPOINT_URL`
  for MinIO/R2, `SYNAPSE_S3_REGION`, `SYNAPSE_S3_ACCESS_KEY_ID`,
  `SYNAPSE_S3_SECRET_ACCESS_KEY`, `SYNAPSE_STORAGE_PRESIGN_SECONDS` 3600).
- Every route: permission `file:read` / `file:write`, and uploads require the
  `api_access` feature (403 `feature_not_entitled`).
- `GET /v1/files` → paged, `ready` rows only, newest first. `FileRead {id,
  organization_id, key, name, content_type, size_bytes, status, created_at}`.
- `POST /v1/files` multipart field `file`, ≤ 10 MiB
  (`MAX_DIRECT_UPLOAD_BYTES`; larger → the reference's `storage_error` 400;
  non-multipart → 400). Order matters: `adjust_gauge("storage_bytes",
  +size)` FIRST (402 `usage_limit_exceeded` before a byte is written), then
  `put`, then the row → 201, `file.uploaded` event.
- `POST /v1/files/presign-upload {name, content_type, size_bytes}`: local
  backend → 409 `presign_unsupported` with `direct_upload_limit_bytes`;
  S3 → reserve the gauge (402 on breach), insert a `pending` row, answer
  `{id, key, url, method: "PUT", headers: {"Content-Type": …}, expires_in}`.
- `POST /v1/files/{id}/complete`: `ready` → idempotent 200; `pending` →
  `head(key)`; missing or size mismatch → release the gauge, soft-delete,
  **commit**, then 409 `upload_incomplete` with `expected_bytes` /
  `actual_bytes` (the release must survive the error); match → `ready`.
- `GET /v1/files/{id}` → the bytes with the stored content type and
  `Content-Disposition: attachment; filename="…"`.
- `POST /v1/files/{id}/presign` → local 409 `presign_unsupported`; S3 →
  `{url, key, expires_in}`.
- `DELETE /v1/files/{id}` → soft-delete, delete the object, `adjust_gauge
  (-size)`, `file.deleted`, 204; then 404. Unknown/foreign/pending-on-read →
  404 (`_get_scoped` with `statuses`).
- Worker retrofit (`worker/jobs.py::purge_expired`, ~lines 469–490): stale
  `pending` uploads are soft-deleted and their reserved bytes released.
- Testing S3: presigning is local SigV4 (unit-testable); for put/get/head use
  MinIO if Docker is available (`docker run -d -p 9000:9000 -e
  MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 minio/minio server
  /data`) or a small S3-shaped stub server; conformance runs on local disk.

## 3. Feature flags — `feature_flags/{service,router,schemas,models,dependencies}.py`, `docs/feature-flags.md`

- Tables `feature_flags` (`key` unique, `enabled`, `rollout_percentage`
  0–100 nullable) and `feature_flag_overrides` (`flag_key`, exactly one of
  `organization_id` / `user_id`, `enabled`, `note`).
- Evaluation (`is_enabled` / `_evaluate`, lines 46–95): unknown flag → false;
  user override → org override → global `enabled`, and when
  `rollout_percentage` is set, deterministic bucketing: `bucket_of(flag_key,
  identifier) = int.from_bytes(sha256(f"{flag_key}:{identifier}")[:4])` mod
  `BUCKETS = 10_000` (read the exact byte slice), in rollout when `bucket <
  BUCKETS * pct // 100`; read which identifier the reference hashes (org vs
  user). Transliterate `bucket_of`/`in_rollout` with the unit tests in
  `tests/unit/feature_flags`.
- Platform-admin routes (tenants get 404): `GET /v1/feature-flags` (paged
  in memory, `FlagRead`), `POST` (201; `key` `^[a-z0-9_.-]+$` 2–100, `name`
  2–200; duplicate → 409 `conflict` with `key`), `PATCH /{key}` (`enabled`,
  `rollout_percentage`; unknown → 404 `feature_flag_not_found`),
  `GET /{key}/overrides` (paged), `POST /{key}/overrides` (201
  `OverrideRead`; neither or both scopes → 422), `DELETE /overrides/{id}`
  (204).
- Tenant route: `GET /v1/feature-flags/check/{key}` → `{key, enabled}` for
  the caller's org + user.
- `require_flag(flag_key)` helper for products (read `dependencies.py` for
  the error it raises). The version-counter cache is a seam only (no Redis).

## 4. Audit — `audit/{router,schemas,service,models}.py`

- Rows are already written by the port's audit writer since milestone 2
  (actor resolution incl. API-key attribution). Route `GET /v1/audit?
  event_type=&actor_user_id=&limit=&offset=` (permission `audit:read`) →
  `{data: AuditEntryRead[], next_cursor: null}` ordered `created_at DESC`;
  `AuditEntryRead {id, organization_id, actor_user_id, actor_type,
  event_type, target_type, target_id, diff, request_id, created_at}`.
  `limit` 1–100 (default 50), `offset ≥ 0`; invalid → 422.
- Make sure every mutating route of milestones 2–5 leaves the same
  `event_type` rows the reference does (grep `AuditService(...).log(` /
  `_audit(` in the reference for the vocabulary).

## 5. Agents — `agents/{service,router,schemas,models}.py`, `docs/agents.md`, ADR 0007

- Table `agents`: `slug` (`^[a-z0-9][a-z0-9-]*$`, 2–100, unique per org
  **including soft-deleted rows** → 409 `conflict` with `slug` on reuse),
  `name` 2–200, `description`, `config` JSONB, `status` active|disabled,
  `deleted_at`.
- The whole router is behind the `agents` feature (`require_feature`,
  403 `feature_not_entitled` with `feature`, `available_in[]`,
  `upgrade_url`) — this is what turns the last conformance test green —
  plus permissions `agents:read` / `agents:manage`.
- Routes: `GET /v1/agents` (paged, `X-Total-Count`, excludes deleted),
  `POST` (201 `AgentRead {id, slug, name, description, status, config,
  created_at, updated_at}`), `GET /{id}`, `PATCH /{id}` (`name`,
  `description`, `config`), `POST /{id}/disable` → `status: disabled`,
  `POST /{id}/enable` → `active`, `DELETE /{id}` → soft-delete 204, then 404.
  Events/audit as `service.py` emits (`agent.registered`, …).

## 6. Tests

Unit: flag bucketing/rollout (transliterated), storage key validation,
`scoped_key`, S3 presign URL shape, envelope/secret masking of endpoint
reads. DB journeys (extend the existing journey suites): endpoint create →
secret once → list masked → delivery produced by dispatching a real event →
list/filter → retry → delete; file upload → list → download bytes → gauge
up → delete → gauge down, 402 when the quota is exhausted, presign 409 on
local (and the S3 path against MinIO or the stub if available: presign-upload
→ PUT → complete → ready; complete without PUT → 409 + reservation
released); flags CRUD + overrides + rollout determinism + tenant 404s; audit
page + filters + API-key attribution; agents CRUD + gate 403 → grant → 200 +
slug reuse 409. Port test suites green.

## 7. Order of work

1. §0 re-pin → commit.
2. §5 agents (small, closes the open conformance failure) → commit.
3. §4 audit route → commit.
4. §3 feature flags → commit.
5. §1 webhook routes → commit.
6. §2 files (local first, then S3) + worker retrofit → commit.
7. §6 journeys, README (status row, env table, conformance target = whole
   suite), full conformance run, push.

## Port-specific mapping (Node / NestJS)

| Piece | Module / file | Notes |
|---|---|---|
| Webhook routes | `src/webhooks/{endpoints.repository.ts,webhooks.service.ts,webhooks.controller.ts,webhooks-routes.module.ts}` | over the milestone-4 `DeliveryService` / `fernet.ts` |
| Storage | `src/storage/{backend.ts,local-disk.backend.ts,s3.backend.ts,keys.ts,files.repository.ts,files.service.ts,files.controller.ts,storage.module.ts}` | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`; multipart via `multer` (`@nestjs/platform-express` `FileInterceptor`, memory storage, `limits.fileSize` above 10 MiB so the reference's 400 rule fires in code, not multer's error) |
| Feature flags | `src/feature-flags/{buckets.ts,flags.repository.ts,flags.service.ts,flags.controller.ts,require-flag.ts,feature-flags.module.ts}` | `PlatformAdminGuard` for admin routes; `TenantGuard` for `/check/:key` |
| Audit route | `src/audit/{audit.repository.ts,audit.controller.ts,audit-routes.module.ts}` | reads the rows `AuditWriter` already writes |
| Agents | `src/agents/{agents.repository.ts,agents.service.ts,agents.controller.ts,agents.module.ts}` | controller-level `@RequireFeature('agents')` + `@RequirePermission` |
| Worker retrofit | `src/worker/jobs.service.ts` `purgeExpired` | stale pending uploads |

Keep: `Database.transaction(fn)` with RLS GUC priming, repositories over
plain `pg`, guards, `ProblemFilter`, `OutboxWriter` / `AuditWriter` in the
same transaction, zod settings in `src/core/config.ts`, the acyclic module
graph (route modules import engines, never the reverse).

Runtime: `postgresql://synapse:synapse@localhost:5434/synapse_node` (server)
and `synapse_node_test` (tests); `PORT=8090`; `SYNAPSE_STORAGE_ROOT` under
the repo's `.storage/` (gitignored) for conformance; `pnpm conformance` = the
whole suite.
