#!/usr/bin/env bash
#
# Console parity (milestone 6): run the REFERENCE console's Playwright journeys
# against this port. The reference's `apps/web` is read-only — it is copied, its
# specs are never edited. Expected result: 22 passed, 1 skipped (sso.spec.ts
# self-skips without E2E_KEYCLOAK=1).
#
#   pnpm e2e:console
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
#   SKIP_CONSOLE_BUILD=1                               reuse an existing build
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REFERENCE_WEB="${REFERENCE_WEB:-$(cd "$ROOT/../synapse-saas/apps/web" 2>/dev/null && pwd || echo "")}"
CONSOLE_DIR="${CONSOLE_DIR:-/tmp/synapse-console-node}"
CONSOLE_PORT="${CONSOLE_PORT:-3400}"
API_PORT="${API_PORT:-8090}"
DATABASE_URL="${DATABASE_URL:-postgresql://synapse:synapse@localhost:5434/synapse_node}"
PG_CONTAINER="${PG_CONTAINER:-synapse-saas-postgres-test-1}"
MAILHOG_NAME="${MAILHOG_NAME:-mailhog-node}"
MAILHOG_SMTP_PORT="${MAILHOG_SMTP_PORT:-1045}"
MAILHOG_HTTP_PORT="${MAILHOG_HTTP_PORT:-8045}"

API_URL="http://localhost:${API_PORT}"
CONSOLE_URL="http://localhost:${CONSOLE_PORT}"
DB_NAME="${DATABASE_URL##*/}"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}}"
API_LOG="${LOG_DIR%/}/synapse-node-api-${API_PORT}.log"
CONSOLE_LOG="${LOG_DIR%/}/synapse-node-console-${CONSOLE_PORT}.log"

API_PID=""
CONSOLE_PID=""

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

cleanup() {
  local status=$?
  log "tearing down"
  [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  docker rm -f "$MAILHOG_NAME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for() { # url label
  for _ in $(seq 1 60); do
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
  pnpm exec playwright test "$@"
