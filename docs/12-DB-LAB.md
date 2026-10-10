# Folio isolated PostgreSQL laboratory (#10 and #11)

## Isolation and commands
Only the Desktop Commander Ubuntu device `mehmet` runs the stack. Docker Compose project **folio_lab**, private network **folio_lab_private**, own data volume **folio_lab_postgres_data**, PostgreSQL loopback port **127.0.0.1:55432**. Other project containers/volumes/networks are not touched. `infra/lab.sh` creates `infra/.env.lab` with a unique local-only password (not committed) on first invocation.

```bash
bash infra/lab.sh up
bash infra/lab.sh health
bash infra/lab.sh migrate
bash infra/lab.sh test-db
bash infra/lab.sh smoke
bash infra/lab.sh down # stops only Folio project, preserves its volume
```

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
