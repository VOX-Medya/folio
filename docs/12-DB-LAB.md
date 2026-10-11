# Folio isolated PostgreSQL laboratory (#10 and #11)

## Isolation and commands
**Primary automated lab: ephemeral GitHub-hosted Ubuntu Actions runner**. The Desktop Commander Ubuntu device `mehmet` is an **optional additional local lab**, not a CI prerequisite. On either machine the Docker Compose project is **folio_lab**, with private network **folio_lab_private**, own data volume **folio_lab_postgres_data**, and PostgreSQL loopback port **127.0.0.1:55432**. Other project containers/volumes/networks are not touched. `infra/lab.sh` creates `infra/.env.lab` with a unique local-only password (not committed) on first invocation. GitHub Actions is not a persistent production database or application server.

```bash
bash infra/lab.sh up
bash infra/lab.sh health
bash infra/lab.sh migrate
bash infra/lab.sh test-db
bash infra/lab.sh smoke
bash infra/lab.sh down # stops only Folio project, preserves its volume
```

The GitHub Actions `full-regression` job runs `db-up`, `migrate`, `test-db` and isolated database/HTTPS smoke commands with synthetic fixtures. Manual Actions `validation=fast` does not run heavy checks; `validation=full` (default) does. The Ubuntu `mehmet` device need not be online. Neither lab should be connected to production data or secrets.

Database `folio_lab` is for local app development; `folio_test` is a **separate database** in the same Folio-only Postgres server, created by `test-db`. `down` does not remove volumes; do not use `down -v`. Production is never deployed without explicit user approval.

## Baseline schema and migration approach
The initial versioned Drizzle migration creates authors, works, N:M work authors, audit events, import-batch shells, btree indexes and a pg_trgm search index. It is a starting schema, not the complete catalog/revision/rights implementation. `pg_trgm` extension is created before the corresponding index in the migration. Immutable text revisions, media, translations, rights gates, and detailed jobs are separate V1 issues.

- `pnpm --filter @folio/db db:generate` after intentional schema changes, followed by SQL review and a forward-only migration. Avoid dropping columns/data or destructive reset.
- `bash infra/lab.sh migrate` applies pending migrations and may be repeated.
- `bash infra/lab.sh smoke` validates extension, tables, FK relationships, transactional rollback, and durable pg-boss roundtrip across a worker restart. Synthetic transient test data is rolled back; a small queue job persists for evidence in the isolated lab schema.

`DATABASE_URL` must be passed explicitly into migration and test processes; running against an unspecified or production DB is prohibited. Database backups and restore drill remain #47.

## Ubuntu lab test evidence, 10 October 2026
Initial Docker Hub image download failed with 502 and was retried; the second pull succeeded. `folio_lab-postgres-1` became healthy and the unrelated `isnad-dev-*` containers remained running. Production DB and real books/user content were not used.

- `pnpm check`: PASS, includes lint, typed packages, unit, HTTP, build, design matrix and OpenAPI drift.
- `bash infra/lab.sh migrate`: PASS on new development DB and again unchanged (idempotent).
- `bash infra/lab.sh test-db`: PASS in separate `folio_test` DB, including pg_trgm, tables/FK, rollback and persistent pg-boss singleton job.
- `bash infra/lab.sh api-smoke`: PASS; real HTTP `/v1/ready` -> 200 when DB is configured; no DB -> 503 in contract test.
- Worker queues for V1 validation/parsing/cover/media are registered, but feature processing handlers have NOT been implemented yet. Retry/error/dead-letter hardening must be verified before closing #10.

## Full Compose lab (#11)
`bash infra/lab.sh up` builds the Node/pnpm/NestJS lab image and starts both `folio_lab-postgres-1` and `folio_lab-api-1`, waiting for health. The API is bound to **127.0.0.1:3310** on the Ubuntu host and uses a dedicated Docker-private DB hostname. `bash infra/lab.sh db-up` is for database-only local tests. The worker is opt-in behind Compose profile `jobs` until actual V1 job handlers are installed. This keeps unused worker processes off.

`bash infra/lab.sh health` checks the local Postgres and HTTP `/v1/ready`. `bash infra/lab.sh down` stops and removes **only** Folio Compose containers and its project network, never a volume; `bash infra/lab.sh up` restores it. Production deployment and image publishing remain prohibited without explicit approval. The image build excludes `.env`, `.git`, node_modules and reports successful local startup only after an HTTP-ready healthcheck.

## Full Docker lab verification (10 October 2026)
The Dockerfile built from the checked-in frozen lockfile with pinned Node 22.22.1 and pnpm 10.34.5. `bash infra/lab.sh up` returned a healthy API and PostgreSQL. Host HTTP `GET http://127.0.0.1:3310/v1/ready` returned `{"status":"ready"}`. `down` followed by `up` returned both containers to healthy status, with the Folio data volume retained and migration repeat succeeding. The list of live `isnad-dev` container IDs was captured before and after the cycle and was identical (`diff` PASS); no unrelated container was changed. A Docker image was built locally only; no image was published or production deployed. CI also builds a non-published lab image.

## Queue acceptance extension (#10, 10 October 2026)
Drizzle migration `0006_normal_darwin.sql` adds durable job completion receipts. For bounded retries/expiry, dead-letter, transaction-bound idempotency and sanitized audit, use `docs/19-DURABLE-JOBS.md` and `bash infra/lab.sh job-smoke` (isolated `folio_test` only). A failed or expired real pg-boss job is verifiably dead-lettered in the lab. Operational handlers for actual books/media remain owned by later V1 feature issues; registration alone is not working content import.
