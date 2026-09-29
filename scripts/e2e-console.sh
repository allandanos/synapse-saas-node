#!/usr/bin/env bash
#
# Console parity: run the REFERENCE console's Playwright journeys against this
# port. The reference's `apps/web` is read-only — it is copied, its specs are
# never edited.
#
#   pnpm e2e:console                22 passed, 1 skipped (sso.spec.ts self-skips)
#   KEYCLOAK=1 pnpm e2e:console     23 passed, 0 skipped (a real Keycloak, SSO too)
#
# Everything is overridable from the environment; the defaults below are the
# Node port's assigned resources and never collide with the reference dev stack.
#
#   REFERENCE_WEB   the reference console to copy      (…/synapse-saas/apps/web)
#   CONSOLE_DIR     where the copy lives               (/tmp/synapse-console-node)
#   CONSOLE_PORT    the console copy's port            (3400)
#   API_PORT        this port's API                    (8090)
#   DATABASE_URL    a database this script may DROP    (synapse_node on :5434)
#   PG_CONTAINER    the container hosting it           (synapse-saas-postgres-test-1)
#   MAILHOG_NAME/_SMTP_PORT/_HTTP_PORT                 (mailhog-node, 1045, 8045)
#   REDIS_NAME/REDIS_PORT                              (redis-node, 6391)
#   KEYCLOAK=1                                         also run the SSO journey
#   KEYCLOAK_NAME/KEYCLOAK_PORT                        (keycloak-node, 8191)
#   SKIP_CONSOLE_BUILD=1                               reuse an existing build
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REFERENCE_WEB="${REFERENCE_WEB:-$(cd "$ROOT/../synapse-saas/apps/web" 2>/dev/null && pwd || echo "")}"
REFERENCE_ROOT="${REFERENCE_ROOT:-$(cd "$ROOT/../synapse-saas" 2>/dev/null && pwd || echo "")}"
CONSOLE_DIR="${CONSOLE_DIR:-/tmp/synapse-console-node}"
CONSOLE_PORT="${CONSOLE_PORT:-3400}"
API_PORT="${API_PORT:-8090}"
DATABASE_URL="${DATABASE_URL:-postgresql://synapse:synapse@localhost:5434/synapse_node}"
PG_CONTAINER="${PG_CONTAINER:-synapse-saas-postgres-test-1}"
MAILHOG_NAME="${MAILHOG_NAME:-mailhog-node}"
MAILHOG_SMTP_PORT="${MAILHOG_SMTP_PORT:-1045}"
MAILHOG_HTTP_PORT="${MAILHOG_HTTP_PORT:-8045}"
REDIS_NAME="${REDIS_NAME:-redis-node}"
REDIS_PORT="${REDIS_PORT:-6391}"
KEYCLOAK="${KEYCLOAK:-0}"
KEYCLOAK_NAME="${KEYCLOAK_NAME:-keycloak-node}"
KEYCLOAK_PORT="${KEYCLOAK_PORT:-8191}"
KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.0}"

API_URL="http://localhost:${API_PORT}"
CONSOLE_URL="http://localhost:${CONSOLE_PORT}"
DB_NAME="${DATABASE_URL##*/}"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}}"
API_LOG="${LOG_DIR%/}/synapse-node-api-${API_PORT}.log"
CONSOLE_LOG="${LOG_DIR%/}/synapse-node-console-${CONSOLE_PORT}.log"
REALM_DIR="${LOG_DIR%/}/synapse-node-keycloak-realm"

API_PID=""
CONSOLE_PID=""

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

cleanup() {
  local status=$?
  log "tearing down"
  [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  docker rm -f "$MAILHOG_NAME" >/dev/null 2>&1 || true
  if [ "$KEYCLOAK" = "1" ]; then docker rm -f "$KEYCLOAK_NAME" >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for() { # url label [tries]
  for _ in $(seq 1 "${3:-60}"); do
    curl -fs -o /dev/null "$1" && return 0
    sleep 1
  done
  echo "timed out waiting for $2 at $1" >&2
  return 1
}

[ -d "$REFERENCE_WEB" ] || { echo "REFERENCE_WEB not found: '$REFERENCE_WEB'" >&2; exit 1; }

log "MailHog ($MAILHOG_NAME: smtp $MAILHOG_SMTP_PORT, http $MAILHOG_HTTP_PORT)"
docker rm -f "$MAILHOG_NAME" >/dev/null 2>&1 || true
docker run -d --name "$MAILHOG_NAME" -p "${MAILHOG_SMTP_PORT}:1025" -p "${MAILHOG_HTTP_PORT}:8025" mailhog/mailhog >/dev/null
wait_for "http://localhost:${MAILHOG_HTTP_PORT}/api/v2/messages" "MailHog"

log "Redis ($REDIS_NAME on $REDIS_PORT)"
docker start "$REDIS_NAME" >/dev/null 2>&1 || docker run -d --name "$REDIS_NAME" -p "${REDIS_PORT}:6379" redis:7-alpine >/dev/null

if [ "$KEYCLOAK" = "1" ]; then
  # The shipped realm only knows the reference's 8000/3000, and the reference
  # tree is read-only: copy it and add this run's origins to the client.
  log "Keycloak ($KEYCLOAK_NAME on $KEYCLOAK_PORT)"
  [ -f "$REFERENCE_ROOT/infrastructure/keycloak/realm-dev.json" ] || { echo "realm-dev.json not found under $REFERENCE_ROOT" >&2; exit 1; }
  rm -rf "$REALM_DIR" && mkdir -p "$REALM_DIR"
  API_URL="$API_URL" CONSOLE_URL="$CONSOLE_URL" python3 "$ROOT/scripts/keycloak-realm.py" \
    "$REFERENCE_ROOT/infrastructure/keycloak/realm-dev.json" "$REALM_DIR/realm-dev.json"
  docker rm -f "$KEYCLOAK_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$KEYCLOAK_NAME" -p "${KEYCLOAK_PORT}:8080" \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
    -v "$REALM_DIR:/opt/keycloak/data/import:ro" \
    "$KEYCLOAK_IMAGE" start-dev --import-realm --http-port=8080 >/dev/null
  wait_for "http://localhost:${KEYCLOAK_PORT}/realms/synapse/.well-known/openid-configuration" "Keycloak" 120 \
    || { docker logs "$KEYCLOAK_NAME" 2>&1 | tail -40 >&2; exit 1; }
fi

if [ "${SKIP_CONSOLE_BUILD:-0}" = "1" ] && [ -d "$CONSOLE_DIR/.next" ]; then
  log "console: reusing the existing build in $CONSOLE_DIR"
else
  log "console: copying $REFERENCE_WEB → $CONSOLE_DIR and building against $API_URL"
  mkdir -p "$CONSOLE_DIR"
  rsync -a --exclude node_modules --exclude .next --exclude test-results \
        --exclude playwright-report --exclude tsconfig.tsbuildinfo "$REFERENCE_WEB/" "$CONSOLE_DIR/"
  (cd "$CONSOLE_DIR" && pnpm install --frozen-lockfile && NEXT_PUBLIC_API_URL="$API_URL" pnpm build)
fi

log "database: recreating $DB_NAME"
docker exec "$PG_CONTAINER" psql -U synapse -d postgres \
  -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);" -c "CREATE DATABASE ${DB_NAME} OWNER synapse;" >/dev/null

# The journeys log in as the dev-seeded owner (a platform admin); no bootstrap admin needed.
export PORT="$API_PORT"
export SYNAPSE_DATABASE_URL="$DATABASE_URL"
export SYNAPSE_WEB_ORIGIN="$CONSOLE_URL"
export SYNAPSE_SMTP_HOST=localhost
export SYNAPSE_SMTP_PORT="$MAILHOG_SMTP_PORT"
export SYNAPSE_SMTP_FROM=billing@synapse.test
export SYNAPSE_BILLING_PROVIDER=manual
export SYNAPSE_AUTO_SYNC_PLANS=true
export SYNAPSE_STORAGE_ROOT=.storage
export SYNAPSE_REDIS_URL="redis://localhost:${REDIS_PORT}/0"
# The journeys register many accounts from one address.
export SYNAPSE_AUTH_RATE_LIMIT_PER_IP=1000
export SYNAPSE_AUTH_RATE_LIMIT_PER_IDENTITY=100

if [ "$KEYCLOAK" = "1" ]; then
  export SYNAPSE_IDENTITY_PROVIDER=keycloak
  export SYNAPSE_KEYCLOAK_BASE_URL="http://localhost:${KEYCLOAK_PORT}"
  export SYNAPSE_KEYCLOAK_REALM=synapse
  export SYNAPSE_KEYCLOAK_CLIENT_ID=synapse-web
  export SYNAPSE_KEYCLOAK_CLIENT_SECRET=dev-client-secret
fi

log "migrate + seed:dev"
(cd "$ROOT" && pnpm migrate >/dev/null && pnpm seed:dev)

log "API on $API_URL (log: $API_LOG)"
(cd "$ROOT" && node -r @swc-node/register src/main.ts > "$API_LOG" 2>&1) &
API_PID=$!
wait_for "${API_URL}/healthz" "the API"

log "console on $CONSOLE_URL (log: $CONSOLE_LOG)"
(cd "$CONSOLE_DIR" && PORT="$CONSOLE_PORT" pnpm start > "$CONSOLE_LOG" 2>&1) &
CONSOLE_PID=$!
wait_for "${CONSOLE_URL}/login" "the console"

log "journeys"
cd "$CONSOLE_DIR"
E2E_BASE_URL="$CONSOLE_URL" \
E2E_API_URL="$API_URL" \
MAILHOG_API_URL="http://localhost:${MAILHOG_HTTP_PORT}" \
E2E_KEYCLOAK="$KEYCLOAK" \
  pnpm exec playwright test "$@"
