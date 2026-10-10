#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/infra/.env.lab"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  printf 'FOLIO_DB_PASSWORD=%s\nFOLIO_DB_PORT=55432\n' "$(openssl rand -hex 24)" > "$ENV_FILE"
  echo 'Created isolated Folio-only lab credentials (not committed).'
fi
set -a
# The generated secret contains only hex and no whitespace.
source "$ENV_FILE"
set +a
export DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_lab"
COMPOSE=(docker compose -p folio_lab --env-file "$ENV_FILE" -f "$ROOT/infra/compose.lab.yml")
case "${1:-help}" in
  up) "${COMPOSE[@]}" up -d --wait --wait-timeout 120 postgres ;;
  down) "${COMPOSE[@]}" down ;;
  health) "${COMPOSE[@]}" ps; "${COMPOSE[@]}" exec -T postgres pg_isready -U folio_lab -d folio_lab ;;
  migrate) pnpm --filter @folio/db db:migrate ;;
  smoke) pnpm --filter @folio/db db:smoke ;;
  api-smoke) pnpm --filter @folio/server exec tsx scripts/check-readiness.ts ;;
  test-db)
    if ! "${COMPOSE[@]}" exec -T postgres psql -U folio_lab -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='folio_test'" | grep -qx 1; then
      "${COMPOSE[@]}" exec -T postgres psql -U folio_lab -d postgres -c 'CREATE DATABASE folio_test'
    fi
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:migrate
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:smoke
    ;;
  *) echo 'Usage: bash infra/lab.sh {up|down|health|migrate|smoke|test-db|api-smoke}'; exit 2 ;;
esac
