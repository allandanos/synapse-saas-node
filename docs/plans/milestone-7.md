# Milestone 7 — OIDC login, OpenFGA authorization, Redis caches, auth rate limiting, Stripe plan sync

Planned by the coordinator against the reference at `synapse-saas@cb1f6d1`
(contract unchanged since `6272ab3`; the last commits are the console-journey
fixes and a CI fix for the OpenFGA job). Every section names the reference
file that holds the exact behaviour; read it before writing the port's
version. The reference server is the oracle; report disagreements (file +
line) instead of fixing them here.

## Gate

1. `tests/conformance` **51/51 in both authorization backends**: once with
   `SYNAPSE_AUTHZ_BACKEND=rbac` (as before) and once with
   `SYNAPSE_AUTHZ_BACKEND=openfga` against a real OpenFGA store you created
   for the run (model written, tuples synced by the worker). Redis on for
   both runs; `SYNAPSE_AUTH_RATE_LIMIT_PER_IP=1000`,
   `SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY=100` (the suite registers many users
   from one IP).
2. Console journeys: **23 passed, 0 skipped** — the 22 from milestone 6 plus
   `sso.spec.ts` with `E2E_KEYCLOAK=1` against a Keycloak running the dev
   realm and this port configured as its OIDC client.
3. Port-native OpenFGA parity: for each of the 5 system roles × 21
   permissions, `user_can` through OpenFGA equals the RBAC answer; project
   inheritance/sharing through `user_can_on`; `closed` vs `rbac` fail modes
   on an outage; API-key principals never consult OpenFGA; tuple sync
   converges after role assign/replace/remove/custom-role edits via the
   worker consumer (mirror `tests/integration/test_openfga_parity.py`).
4. Rate limiting, caching and Stripe-sync tests as listed in §6.
5. The port's own suites green.

## 1. Redis-backed versioned cache — `core/cache.py`, `core/redis.py`, `tests/unit/core/test_cache.py`

Build this first: the OIDC state, the OpenFGA check cache and the rate
limiter sit on it.

- `VersionedCache(namespace, ttl)`: version key `{ns}:v:{key}` (INCR; TTL
  3600 s), body key `{ns}:{key}:{version}` (TTL = namespace TTL).
  `get_versioned(key) -> (body|None, version)`; `set(key, value, *,
  version)` writes under the version **observed at read time** — never a
  version re-read at write time; `get_scoped(key, *scopes) -> (body,
  token)` where the token is the joined current versions of the scope keys,
  `set_scoped(key, value, token)`; `bump(key)` = INCR; `delete(key)` = bump
  (resetting to 0 would resurrect a stale body). Read the docstring's three
  correctness rules and the unit tests; port them.
- Deferred invalidation: `defer_bump(tx, cache, key)` records the bump on the
  transaction; `flush_deferred_bumps` runs after **commit** (the request
  transaction does it automatically; jobs call the helper). Invalidation
  before commit lets a concurrent reader cache pre-commit rows under the new
  version.
- Namespaces + TTLs: read the constants (`member` 60 s in
  `tenancy/dependencies.py`, `perm` 30 s and `fga` 30 s in
  `authorization/service.py`, entitlements in `entitlements/service.py`, flags
  in `feature_flags/service.py`, `oidc` 600 s in `identity/router.py`). Wire
  every cache seam the port left (`EntitlementCache`/`invalidate(...)`, flag
  evaluation, permission sets, membership lookups) through this class, and
  bump exactly where the reference bumps.
- No `SYNAPSE_REDIS_URL` ⇒ pass-through (compute every time) — document it;
  the reference's in-process TTL dict is a dev convenience you may skip.
  Redis errors on read/write are logged and treated as a miss, never a 500.
- `/readyz`: `checks.redis` = `ok` | `error: …` | `not_configured` and the
  overall status/503 rule from `api/app.py`.

## 2. Auth rate limiting — `identity/rate_limit.py`, `core/rate_limit.py`, `core/config.py`

- Routes and identity fields (`AUTH_ROUTES`): `/v1/auth/login` (email),
  `/register` (email), `/forgot-password` (email), `/reset-password` (IP
  only), `/refresh` (IP only), `/oidc/start` and `/oidc/callback` (IP only).
- Fixed window of `SYNAPSE_AUTH_RATE_WINDOW_SECONDS` (read the default);
  limits `SYNAPSE_AUTH_RATE_LIMIT_PER_IP` (default 20) and
  `SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY` (default 5, keyed on the lowercased
  identity peeked from the JSON body without consuming it for the handler).
  Redis `INCR` + `EXPIRE`; in-process counters when Redis is not configured;
  **a Redis error fails open** (log + metric, request proceeds).
- Client IP: the peer address, unless the peer is inside
  `SYNAPSE_TRUSTED_PROXIES` (CIDR list) in which case walk
  `X-Forwarded-For` right-to-left to the first untrusted hop
  (`_client_ip`, `_is_trusted_proxy`; tests in
  `tests/unit/identity/test_client_ip.py`).
- 429 problem document `rate_limited` with `Retry-After` (seconds left in
  the window) — read `_too_many` for the extras.
- Production guardrails (`core/config.py`): with `SYNAPSE_ENV=production`,
  per-IP above 100 or per-identity above 20 refuses to boot, like the other
  guardrails the port already mirrors.

## 3. OpenFGA behind the authorization service — ADR 0009, `docs/authorization.md`

Reference: `authorization/fga_model.py`, `fga.py`, `sync.py`, `service.py`
(`user_can`, `user_can_on`, `_fga_allowed`), `dependencies.py`, `cli.py`
(`authz fga …`), `worker/jobs.py` (post-commit consumer hook),
`core/config.py` (`authz_backend`, `openfga_url/store_id/model_id/api_token`,
`openfga_fail_mode`), tests `tests/unit/authorization/{test_fga_client,
test_fga_model,test_authz_backend}.py`, `tests/integration/test_openfga_parity.py`.

- **Model** generated from the permission catalog (transliterate
  `build_model()` + `render_dsl()` with their tests): schema 1.1; `type
  user`; `type organization` with the five role relations (`owner`, `admin`,
  `billing`, `developer`, `member`, each `[user]`) and one `can_<perm>`
  relation per catalog permission (`:` → `_`) defined as `[user] or <every
  system role holding it>` (a permission no tenant role holds is `[user]`
  only); `type project` with `org: [organization]`, `viewer: [user] or
  editor or can_project_read from org`, `editor: [user] or
  can_project_manage from org`. `relation_for(perm)`, `roles_holding(perm)`,
  `ROLE_ORDER`.
- **Client** (`FgaClient`): `check`, `list_objects`, `write(writes, deletes)`
  (read how duplicate writes / missing deletes are tolerated), `read_tuples`,
  `create_store`, `write_model`; bearer `SYNAPSE_OPENFGA_API_TOKEN`; store and
  model ids from settings (empty model id ⇒ latest); unreachable/HTTP errors
  ⇒ `FgaError` (read its status/title in `core/errors.py` + `fga.py`).
- **Dispatch**: `user_can(user, org, perm)` — rbac: the denormalised
  permission set; openfga: `check(user:<id>, can_<perm>, organization:<id>)`
  through the `fga` scoped cache (30 s, scope `{user}:{obj}`, bumped with the
  permission cache); `user_can_on(user, perm, type, id)` for resource-level
  checks (rbac backend answers organization objects only); on an outage the
  fail mode decides: `closed` ⇒ deny (log), `rbac` ⇒ fall back for
  organization objects only; metric `synapse_fga_checks_total{outcome}`.
  `permission_keys_for` (what the user context/console reads) stays RBAC.
  **API-key principals use their scopes and never consult OpenFGA.**
- **Tuple sync** (`sync.py`): `desired_tuples(user, org, role_keys,
  permission_keys)` = one `(user, <role>, organization)` tuple per system
  role held + direct `(user, can_<perm>, organization)` tuples only for
  permissions that come from custom roles; `queue_tuple_sync(tx,
  organization_id, user_id|None)` appends the **internal** outbox event
  `authz.tuples_changed {organization_id, user_id}` wherever the reference
  does (accept invite, role assign/replace, membership status change,
  removal, custom-role create/update/delete ⇒ whole org, org deletion);
  the worker's post-commit consumer `apply_tuple_sync` reads the user's
  current tuples on the org object, diffs against desired, writes/deletes
  (whole org when `user_id` is null). When the backend is rbac the events
  are still emitted but the consumer is a no-op (read `handle_event`).
- **CLI**: `authz fga write-model [--create-store NAME] [--dsl]`, `authz fga
  sync --all | --org ID`, `authz fga check USER ORG PERMISSION` (same
  outputs).
- Runtime: the shared local OpenFGA at `http://localhost:8081` (container
  `synapse-saas-openfga-1`, in-memory). **Create your own store** for every
  run/test (`POST /stores`), never reuse or list others'; both ports share
  the server.

## 4. OIDC login (Keycloak, authorization code + PKCE) — ADR 0010, `docs/identity.md`

Reference: `identity/provider.py` (`KeycloakOIDCProvider`,
`LocalIdentityProvider`, `get_identity_provider`, JWKS cache),
`identity/router.py` lines ~105–195 (`oidc_start`, `oidc_callback`,
`_callback_uri`, `_safe_return_to`), `identity/service.py::login` (SSO-only
⇒ 401 with `sso_url`, already ported) and `link_or_create_oidc_user`,
`core/config.py`, tests `tests/unit/identity/test_keycloak_provider.py`,
`tests/integration/test_oidc_login.py`, `apps/web/e2e/sso.spec.ts`,
`.github/workflows/e2e-sso.yml`, `infrastructure/keycloak/realm-dev.json`,
the console's `/auth/callback` page and login-page SSO button.

- `GET /v1/auth/oidc/start?return_to=`: opaque `state`, PKCE verifier +
  S256 challenge, `nonce`; store `{verifier, nonce, return_to}` under the
  state in the `oidc` cache (600 s, single use); 302 to
  `{base}/realms/{realm}/protocol/openid-connect/auth` with `client_id`,
  `redirect_uri`, `response_type=code`, `scope`, `state`, `nonce`,
  `code_challenge`, `code_challenge_method=S256` (read the exact scope
  string and any extra params). `return_to` is sanitised to a same-site
  path (`_safe_return_to`).
- `GET /v1/auth/oidc/callback?code&state[&error]`: `error` ⇒ 401 problem;
  missing code/state ⇒ 401; unknown/expired/replayed state ⇒ 401
  ("Unknown or expired login state"); token exchange at
  `…/protocol/openid-connect/token` (client id + secret, code,
  redirect_uri, code_verifier) ⇒ `id_token` required; verify RS256 with the
  realm JWKS (cached 1 h per issuer, refetched once on an unknown `kid`),
  `iss` = `{base}/realms/{realm}`, `aud` = client id, `exp`, and the bound
  `nonce`; link: `(identity_provider, provider_subject)` → else email
  **only when `email_verified` is true** → else create an SSO-only user
  (no password hash); inactive ⇒ 401; then the normal token issue: set the
  `synapse_rt` cookie and 302 to `{web_origin}/auth/callback[?return_to=…]`
  — never tokens in the URL (the console calls `/v1/auth/refresh`).
- `redirect_uri` = `SYNAPSE_OIDC_REDIRECT_URI` when set, else the absolute
  URL of the callback route.
- ROPC (`verify_credentials` via the password grant) only when
  `SYNAPSE_KEYCLOAK_ALLOW_PASSWORD_GRANT=true`.
- Settings: `SYNAPSE_IDENTITY_PROVIDER=local|keycloak`,
  `SYNAPSE_KEYCLOAK_BASE_URL`, `SYNAPSE_KEYCLOAK_REALM`,
  `SYNAPSE_KEYCLOAK_CLIENT_ID`, `SYNAPSE_KEYCLOAK_CLIENT_SECRET`,
  `SYNAPSE_KEYCLOAK_ALLOW_PASSWORD_GRANT`, `SYNAPSE_OIDC_REDIRECT_URI`;
  `GET /v1/meta.identity_provider` reflects it (the console shows the SSO
  button when it is `keycloak`).
- **Keycloak for the journey** (image `quay.io/keycloak/keycloak:26.0`, pull
  from quay works here): copy `infrastructure/keycloak/realm-dev.json` to a
  temp dir and add `http://localhost:<api port>/*` and
  `http://localhost:<console port>/*` to the `synapse-web` client's
  `redirectUris` (and `webOrigins` if present) — the shipped realm only
  knows 8000/3000; run `docker run -d --name <keycloak name> -p
  <host port>:8080 -v <tmp dir>:/opt/keycloak/data/import:ro
  quay.io/keycloak/keycloak:26.0 start-dev --import-realm --http-port=8080`
  and wait for `/realms/synapse/.well-known/openid-configuration`. Realm
  users: `sso@acme.example.com` / `password123` (verified),
  `unverified@acme.example.com`. Client `synapse-web`, secret
  `dev-client-secret`. Server env: `SYNAPSE_IDENTITY_PROVIDER=keycloak
  SYNAPSE_KEYCLOAK_BASE_URL=http://localhost:<host port>
  SYNAPSE_KEYCLOAK_REALM=synapse SYNAPSE_KEYCLOAK_CLIENT_ID=synapse-web
  SYNAPSE_KEYCLOAK_CLIENT_SECRET=dev-client-secret`; journeys with
  `E2E_KEYCLOAK=1`. Extend the milestone-6 recipe script with a
  `KEYCLOAK=1` mode that does all of this and tears the container down.

## 5. Stripe plan sync — `cli.py` (~lines 330–360), `billing/providers/stripe_provider.py::upsert_product_and_price`

Read the CLI command that walks the catalog and calls
`upsert_product_and_price` for every paid plan, and where it stores the
returned provider refs; port it as the port's plan-sync command with a
`--stripe`/provider switch, tested against a local stub Stripe server.

## 6. Tests

Unit: cache semantics (port `test_cache.py`), rate limiter windows +
fail-open, client-IP/XFF matrix, JWKS verification matrix (good token,
wrong issuer, wrong audience, expired, nonce mismatch, unknown kid then
refetch — sign with an in-test RSA key), FGA model equals the reference's
DSL (a fixture with the DSL above), `desired_tuples`, `relation_for`.
DB/integration: parity matrix against the shared OpenFGA (own store),
project inheritance + sharing, closed vs rbac fail modes with the store URL
pointed at a dead port, API-key bypass, tuple sync convergence through the
worker consumer; OIDC callback against a stub IdP (state replay, bad
signature, verified-email link, subject link, SSO-only create, cookie +
refresh); rate-limit 429/Retry-After per IP and per identity, XFF trust;
Stripe sync against the stub. Console: the milestone-6 recipe with
`KEYCLOAK=1` ⇒ 23 passed.

## 7. Order of work

1. §1 cache + `/readyz` → commit.
2. §2 rate limiting → commit.
3. §3 OpenFGA (model, client, dispatch, sync, CLI) → parity tests → commit;
   conformance in openfga mode.
4. §4 OIDC + Keycloak → `sso.spec.ts` → commit.
5. §5 Stripe sync → commit.
6. Gates, README (milestone-7 row, env table, "Hardening" section, recipe
   modes), push.

## Port-specific (Node / NestJS)

| Piece | Module / file |
|---|---|
| Cache | `src/core/cache/{versioned-cache.ts,redis.backend.ts,pass-through.backend.ts,deferred-bumps.ts}` — `ioredis`; deferred bumps attached to the `Tx` object and flushed by `Database.transaction` after commit |
| Rate limiting | `src/identity/rate-limit/{auth-rate-limit.middleware.ts,rate-limiter.ts,client-ip.ts}` — Express middleware mounted before the body parser for the auth routes (peek the identity from the raw body) |
| OpenFGA | `src/authorization/fga/{model.ts,client.ts,sync.ts,settings.ts}`; dispatch inside `AuthorizationService`; CLI `pnpm authz:fga -- write-model|sync|check`; worker consumer registered next to `notifications.handle` in `JobsService.dispatchOutbox` |
| OIDC | `src/identity/oidc/{keycloak.provider.ts,jwks.ts,pkce.ts,oidc.controller.ts}` — `jose` is ESM-only under your CJS build (you hit this before): use `jsonwebtoken` + `jwks-rsa`, or a small RS256 verifier over `crypto.createPublicKey(jwk)` |
| Stripe sync | `pnpm plans:sync -- --stripe` |

Runtime (your row only): API **8090**; DB `postgresql://synapse:synapse@localhost:5434/synapse_node`
(+ `synapse_node_test`); console copy `/tmp/synapse-console-node` on **3400**;
MailHog `mailhog-node` 1045/8045; **Redis container `redis-node` on host
6391** (`docker run -d --name redis-node -p 6391:6379 redis:7-alpine`, cached);
**Keycloak container `keycloak-node` on host 8190**; OpenFGA shared
`http://localhost:8081` with your own store. Never touch `synapse-saas-*`
compose containers beyond creating stores, the other port's ports
(8080/3300/1035/8035/6390/8180), or the reference dev stack.
