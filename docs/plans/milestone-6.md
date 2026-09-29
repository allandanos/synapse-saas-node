# Milestone 6 — console parity (the reference console's Playwright journeys against this port)

Planned by the coordinator against the reference at `synapse-saas@6272ab3`
(contract unchanged since milestone 5 — no re-pin needed). The console and its
specs live in the reference repo and are **never modified**: milestone 6 is
done when the unmodified console, built against this port, passes every
journey. Fix the port, not the console.

## Gate

1. `pnpm exec playwright test` in a copy of `apps/web` (see §3) with
   `E2E_API_URL` = this port: **22 passed** — `auth.spec.ts` (5),
   `agents.spec.ts` (3), `billing.spec.ts` (5), `platform.spec.ts` (5),
   `invoice-email.spec.ts` (4). `sso.spec.ts` self-skips without
   `E2E_KEYCLOAK=1` (milestone 7) — 1 skipped is expected, nothing else.
2. `tests/conformance` still 51/51 against the same server build.
3. The port's own suites green.

## 1. The harness contract — read these first, in full

- `/Users/allan/workspace/100ai/synapse-saas/apps/web/e2e/fixtures.ts`: `E2E_API_URL`,
  `E2E_BASE_URL`, `MAILHOG_API_URL`, `E2E_PLATFORM_ADMIN_EMAIL/PASSWORD`
  (default `owner@acme.example.com` / `password123` = the dev seed);
  `createStackContext` registers `e2e-<run>-<label>@example.com` and creates an
  org through the API; `loginConsole` plants the **`synapse_rt`** refresh cookie
  (HttpOnly, SameSite=Lax, path `/`, host = console hostname) and a
  `synapse_org` cookie, then loads `/dashboard` and relies on the console's
  silent `POST /v1/auth/refresh` (credentials included) to mint an access
  token; `loginViaUi` drives `/login`; `mailhogMessages` / the wait helper poll
  `GET {MAILHOG_API_URL}/api/v2/messages?limit=50` — note the timeout.
- The five spec files: every API call they make directly, every UI flow, and
  every email they expect (subject, recipient, attachment).
- `/Users/allan/workspace/100ai/synapse-saas/apps/web/src/lib/api.ts` and the auth
  context under `src/`: `NEXT_PUBLIC_API_URL` is baked in at `next build`;
  every request is `fetch(..., { credentials: "include" })`; how `X-Org-Id`
  is derived (the `synapse_org` cookie / `switch-org`); how a 401 triggers
  the refresh and a failed refresh redirects to `/login`.
- `/Users/allan/workspace/100ai/synapse-saas/.github/workflows/e2e.yml`: the CI
  recipe (env, seed, boot order) you are reproducing with this port in the
  API's place.
- Reference server behaviour the console depends on: `src/synapse_saas/api/app.py`
  (CORS: the web origin(s) with credentials, `X-Total-Count` exposed, the
  request headers allowed), `src/synapse_saas/identity/router.py`
  (`_set_refresh_cookie`: name, flags, `Secure` only for https/production,
  max-age; logout clears it), `core/config.py` (`web_origin`, `web_origins`,
  `cookie_secure`).

## 2. Dev seed parity — `src/synapse_saas/seeds/dev_seed.py`, replicate exactly

Idempotent (`owner@acme.example.com` already present ⇒ skip). Password
`password123` (argon2id). Users, all `@acme.example.com`, display name
`Acme <Role>`:

| email | role | notes |
|---|---|---|
| owner | owner | `is_platform_admin = true`; creates org **Acme Corporation**, slug **acme** (goes through the normal create-org path ⇒ free subscription, seat gauge, `org.created`) |
| admin | admin | invited by the owner with `role_keys=[role]`, then auto-accepted (`accept_invite_by_email`) |
| billing | billing | same |
| developer | developer | same |
| member | member | same |

Expose it as the port's dev-seed command (never in production; refuse when
the environment is production like the reference). The system seed (roles,
permissions, plan catalog sync) must run first.

## 3. Isolation — the two ports run at the same time on this machine

Never touch the reference's dev stack (`:5433`, `:6380`, MailHog `:1025/:8025`,
console `:3000`) or the other port's resources. Use only your row:

| | Java port | Node port |
|---|---|---|
| API | `http://localhost:8080` | `http://localhost:8090` |
| Database | `synapse_java` on `[::1]:5434` | `synapse_node` on `localhost:5434` |
| Console copy | `/tmp/synapse-console-java` on **:3300** | `/tmp/synapse-console-node` on **:3400** |
| MailHog | container `mailhog-java`, SMTP **1035**, HTTP **8035** | container `mailhog-node`, SMTP **1045**, HTTP **8045** |

Recipe:

```bash
# MailHog (image mailhog/mailhog:latest is cached locally)
docker run -d --name <mailhog-name> -p <smtp>:1025 -p <http>:8025 mailhog/mailhog

# Console copy — the reference's apps/web is read-only; copy it, its own
# pnpm-lock.yaml is self-contained; chromium is already installed for Playwright
rsync -a --exclude node_modules --exclude .next --exclude test-results \
  --exclude playwright-report /Users/allan/workspace/100ai/synapse-saas/apps/web/ <console dir>/
cd <console dir> && pnpm install --frozen-lockfile
NEXT_PUBLIC_API_URL=<api url> pnpm build
PORT=<console port> nohup pnpm start > /tmp/console-<port>.log 2>&1 &

# Port server: fresh database, system seed + dev seed, then boot with
#   SYNAPSE_WEB_ORIGIN=<console url>          (CORS + cookie policy)
#   SYNAPSE_SMTP_HOST=localhost SYNAPSE_SMTP_PORT=<smtp> SYNAPSE_SMTP_FROM=billing@synapse.test
#   SYNAPSE_BILLING_PROVIDER=manual  SYNAPSE_AUTO_SYNC_PLANS=true  worker enabled
#   local-disk storage, bootstrap admin not needed (the dev seed owner is the operator)

# Journeys
cd <console dir> && E2E_BASE_URL=http://localhost:<console port> \
  E2E_API_URL=<api url> MAILHOG_API_URL=http://localhost:<http> \
  pnpm exec playwright test
```

Videos, traces and screenshots land in `<console dir>/test-results/`; read
the failing test's `error-context.md`/screenshot before changing code.

## 4. What usually breaks (check each against the specs)

- **CORS**: the console origin must be allowed *with credentials*; preflights
  for `PATCH`/`DELETE` and for the `Authorization`, `X-Org-Id`, `X-Request-Id`,
  `Content-Type` headers; `X-Total-Count` exposed.
- **Refresh cookie**: exact name `synapse_rt`, `HttpOnly`, `SameSite=Lax`,
  `Path=/`, **not** `Secure` on plain-http localhost, set on register/login/
  refresh/switch-org, cleared on logout; the refresh endpoint must accept the
  cookie when the body is empty.
- **Org context**: how the console sends the active org (`X-Org-Id` from the
  `synapse_org` cookie vs the `org` claim after `switch-org`) — support both
  exactly like the reference.
- **Emails**: invite and invoice mails must reach MailHog within the fixture's
  polling window ⇒ outbox dispatch every 5 s + the SMTP notifier + the PDF
  attachment on `invoice.email`; check the subjects/recipients the specs
  match on.
- **Operator flows** (`platform.spec.ts`): the seeded owner is a platform
  admin; grants by org id, feature-flag admin, revenue reports.
- **Agents** (`agents.spec.ts`): the `agents` feature is granted through the
  platform API, then the console's agents page drives the CRUD.
- **Billing** (`billing.spec.ts`): manual checkout + confirm, plan change
  visible in the console, invoices list/detail, operator payment.
- Shapes the console reads that conformance does not assert (e.g. `me`
  orgs list, `subscription` envelope fields, member `role_keys`,
  `X-Total-Count` on tables) — the specs will show you.

## 5. Deliverables

1. Dev-seed command + tests (users, roles, platform flag, org slug).
2. Any server fixes the journeys demand (each with a port test).
3. A scripted recipe in the port (`make e2e` / `pnpm e2e:console` taking
   `CONSOLE_DIR`, ports and MailHog from env with the defaults above) that
   builds the console copy, boots MailHog + the server, runs the journeys and
   tears down; README milestone-6 row + a "Console parity" section listing
   any console-visible differences (ideally none).
4. Final runs: journeys 22 passed / 1 skipped, conformance 51/51, port
   suites green. Stop the server, the console and your MailHog container.

## 6. Order of work

1. Dev seed + its test → commit.
2. MailHog + console copy up; boot the port; run `auth.spec.ts` alone; fix
   CORS/cookie issues → commit.
3. `platform.spec.ts`, `agents.spec.ts`, `billing.spec.ts` → fix → commit.
4. `invoice-email.spec.ts` (worker + SMTP + PDF) → fix → commit.
5. Full journey run, conformance, port suites, recipe script, README → push.

## Port-specific (Node / NestJS)

- Dev seed: `src/cli/seed-dev.ts` (`pnpm seed:dev`), reusing the identity /
  tenancy services (org creation, invite, accept) so every side effect matches.
- Server env for the journeys: `PORT=8090`,
  `SYNAPSE_DATABASE_URL=postgresql://synapse:synapse@localhost:5434/synapse_node`,
  `SYNAPSE_WEB_ORIGIN=http://localhost:3400`, `SYNAPSE_SMTP_HOST=localhost`,
  `SYNAPSE_SMTP_PORT=1045`, `SYNAPSE_SMTP_FROM=billing@synapse.test`,
  `SYNAPSE_BILLING_PROVIDER=manual`, `SYNAPSE_AUTO_SYNC_PLANS=true`,
  `SYNAPSE_STORAGE_ROOT=.storage`, worker enabled (default).
- Console copy `/tmp/synapse-console-node` on **:3400**; MailHog container
  `mailhog-node` (`-p 1045:1025 -p 8045:8025`); `MAILHOG_API_URL=http://localhost:8045`.
- CORS is configured in `configureHttp` (`main.ts`); the cookie in the
  identity controller (`cookie-parser` is already wired).
- Recipe target: `pnpm e2e:console` (script under `scripts/e2e-console.sh`).
