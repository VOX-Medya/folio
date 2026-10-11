#!/usr/bin/env bash
# #47: Synthetic, non-deploy proof of a Folio-only PostgreSQL + private-volume restore.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${CI:-}" != "true" ]]; then
  echo "Restore proof is restricted to ephemeral GitHub Actions." >&2
  exit 2
fi
if [[ "${FOLIO_DB_PORT:-}" != "55432" || -z "${FOLIO_DB_PASSWORD:-}" ]]; then
  echo "Folio-only isolated lab configuration required." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
compose=(docker compose -p folio_lab --env-file "$ROOT/infra/.env.lab" -f "$ROOT/infra/compose.lab.yml")
origin="$("${compose[@]}" ps -q postgres)"
if [[ -z "$origin" ]] || ! docker exec "$origin" pg_isready -U folio_lab -d folio_test >/dev/null; then
  echo "Dedicated folio_test database not available." >&2
  exit 2
fi

umask 077
scratch="$(mktemp -d)"
marker="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
original_volume="folio_lab_private_assets"
restore="folio_restore_${GITHUB_RUN_ID:-ci}_$$"
restore_pg="folio_restore_pg_${GITHUB_RUN_ID:-ci}_$$"
restore_assets="folio_restore_assets_${GITHUB_RUN_ID:-ci}_$$"
docker volume inspect "$original_volume" >/dev/null 2>&1 || docker volume create "$original_volume" >/dev/null
cleanup(){
  docker rm -f "$restore" >/dev/null 2>&1 || true
  docker volume rm "$restore_pg" "$restore_assets" >/dev/null 2>&1 || true
  docker run --rm --network none -v "$original_volume:/vault" alpine:3.21 \
    sh -c 'rm -f "/vault/backup-proof/$1"' -- "$marker" >/dev/null 2>&1 || true
  docker exec "$origin" psql -U folio_lab -d folio_test -q -c \
    "DELETE FROM audit_events WHERE id='$marker' AND action='backup.smoke';" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

# Deterministic canaries are synthetic; the existing Folio lab is never reset.
docker exec "$origin" psql -U folio_lab -d folio_test -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO audit_events (id,action,entity_type,reason)
   VALUES ('$marker','backup.smoke','ci_restore','synthetic_only');"
docker run --rm --network none -v "$original_volume:/vault" alpine:3.21 \
  sh -ec 'umask 077; mkdir -p /vault/backup-proof; printf "%s" "$1" > "/vault/backup-proof/$1"' -- "$marker"

# Export database and private bytes separately, with no paths outside this lab.
docker exec "$origin" pg_dump -U folio_lab -d folio_test --format=custom > "$scratch/folio_test.dump"
docker run --rm --network none -v "$original_volume:/vault:ro" -v "$scratch:/backup" alpine:3.21 \
  sh -ec 'umask 077; tar -C /vault -cf /backup/assets.tar .'
test -s "$scratch/folio_test.dump"
test -s "$scratch/assets.tar"

# Prove restoration in completely fresh Postgres and asset volumes, with NO exposed port.
docker volume create "$restore_pg" >/dev/null
docker volume create "$restore_assets" >/dev/null
docker run -d --rm --name "$restore" --network none \
  -e POSTGRES_DB=folio_test -e POSTGRES_USER=folio_lab \
  -e "POSTGRES_PASSWORD=$FOLIO_DB_PASSWORD" \
  -v "$restore_pg:/var/lib/postgresql/data" postgres:17-alpine >/dev/null
ready=false
for _ in $(seq 1 40); do
  if docker exec "$restore" pg_isready -U folio_lab -d folio_test >/dev/null 2>&1; then
    ready=true;break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  echo "Restored PostgreSQL did not become ready." >&2;exit 1
fi
docker exec -i "$restore" pg_restore --exit-on-error --clean --if-exists \
  --no-owner --no-privileges -U folio_lab -d folio_test < "$scratch/folio_test.dump"
docker run --rm --network none -v "$restore_assets:/vault" -v "$scratch:/backup:ro" alpine:3.21 \
  sh -ec 'umask 077; tar -C /vault -xf /backup/assets.tar'

count="$(docker exec "$restore" psql -U folio_lab -d folio_test -At -c \
  "SELECT COUNT(*) FROM audit_events WHERE id='$marker' AND action='backup.smoke';")"
if [[ "$count" != "1" ]]; then
  echo "Database canary was not restored exactly once." >&2;exit 1
fi
expected="$(printf '%s' "$marker" | sha256sum | cut -d' ' -f1)"
actual="$(docker run --rm --network none -v "$restore_assets:/vault:ro" alpine:3.21 \
  sha256sum "/vault/backup-proof/$marker" | cut -d' ' -f1)"
if [[ "$actual" != "$expected" ]]; then
  echo "Restored private asset checksum differs." >&2;exit 1
fi
echo "FOLIO BACKUP/RESTORE PASS: isolated PostgreSQL snapshot and SHA-256 private-volume restore, no production data."
