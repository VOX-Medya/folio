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
  up) "${COMPOSE[@]}" up -d --build --wait --wait-timeout 180 postgres api ;;
  db-up) "${COMPOSE[@]}" up -d --wait --wait-timeout 120 postgres ;;
  down) "${COMPOSE[@]}" down ;;
  health) "${COMPOSE[@]}" ps; "${COMPOSE[@]}" exec -T postgres pg_isready -U folio_lab -d folio_lab; curl -fsS "http://127.0.0.1:${FOLIO_API_PORT:-3310}/v1/ready" ;;
  migrate) pnpm --filter @folio/db db:migrate ;;
  smoke) pnpm --filter @folio/db db:smoke ;;
  api-smoke) pnpm --filter @folio/server exec tsx scripts/check-readiness.ts ;;
  device-sessions-http-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server device-sessions:http-smoke ;;
  onboarding-http-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server onboarding:http-smoke ;;
  onboarding-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:onboarding-smoke ;;
  web-self-https-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server web-self:https-smoke ;;
  admin-totp-https-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server admin-totp:https-smoke ;;
  admin-catalog-https-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server admin-catalog:https-smoke ;;
  web-auth-https-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server web-auth:https-smoke ;;
  web-cookie-https-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server web-cookie:https-smoke ;;
  auth-admission-http-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server auth:admission-http-smoke ;;
  auth-http-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/server auth:http-smoke ;;
  auth-rate-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:auth-rate-smoke ;;
  session-cap-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:session-cap-smoke ;;
  admin-rbac-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:admin-rbac-smoke ;;
  admin-totp-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:admin-totp-smoke ;;
  admin-totp-rotation-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:admin-totp-rotation-smoke ;;
  admin-mfa-recovery-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:admin-mfa-recovery-smoke ;;
  admin-role-lifecycle-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:admin-role-lifecycle-smoke ;;
  auth-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:auth-smoke ;;
  storage-quota-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:storage-quota-smoke ;;
  storage-integrity-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:storage-integrity-smoke ;;
  storage-malware-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:storage-malware-smoke ;;
  storage-epub-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:storage-epub-smoke ;;
  import-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:import-smoke ;;
  job-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:job-smoke ;;
  audio-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:audio-smoke ;;
  translation-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:translation-smoke ;;
  rights-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:rights-smoke ;;
  content-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:content-smoke ;;
  catalog-smoke)
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:catalog-smoke ;;
  test-db)
    if ! "${COMPOSE[@]}" exec -T postgres psql -U folio_lab -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='folio_test'" | grep -qx 1; then
      "${COMPOSE[@]}" exec -T postgres psql -U folio_lab -d postgres -c 'CREATE DATABASE folio_test'
    fi
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:migrate
    DATABASE_URL="postgresql://folio_lab:${FOLIO_DB_PASSWORD}@127.0.0.1:${FOLIO_DB_PORT}/folio_test" pnpm --filter @folio/db db:smoke
    ;;
  *) echo 'Usage: bash infra/lab.sh {up|db-up|down|health|migrate|smoke|test-db|api-smoke|catalog-smoke|content-smoke|rights-smoke|translation-smoke|audio-smoke|job-smoke|import-smoke|storage-quota-smoke|storage-integrity-smoke|storage-malware-smoke|auth-smoke|admin-rbac-smoke|admin-totp-smoke|admin-totp-rotation-smoke|admin-mfa-recovery-smoke|admin-role-lifecycle-smoke|auth-rate-smoke|session-cap-smoke|onboarding-smoke|onboarding-http-smoke|device-sessions-http-smoke|auth-http-smoke|auth-admission-http-smoke|web-cookie-https-smoke|web-auth-https-smoke|web-self-https-smoke|admin-totp-https-smoke|admin-catalog-https-smoke}'; exit 2 ;;
esac
