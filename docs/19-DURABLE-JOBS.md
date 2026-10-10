# Folio V1 PostgreSQL durable jobs: acceptance and operating contract (#10)

## Scope and isolation
The only V1 queues are `folio.import.validate`, `folio.book.parse`, `folio.cover.render`, and `folio.media.validate`. No AI generation, provider orchestration, source scraping, Redis, RabbitMQ, or extra worker service exists. The Node worker in `apps/worker` **registers queues only**. Real parser, cover and media handlers will be installed with their relevant V1 features; no fake processor pretends to import content.

Local Ubuntu development uses only Docker Compose project `folio_lab`, Postgres on `127.0.0.1:55432`, network `folio_lab_private`, and volume `folio_lab_postgres_data`. `bash infra/lab.sh test-db` creates and migrates a separate `folio_test` database in that Folio-only container. All job-policy/timeout/error tests refuse to run except against the explicit `folio_test` database. Other services, Docker volumes, ports and unrelated project databases are never modified. Automated GitHub CI starts an **ephemeral** Folio-only Postgres container before integration tests; its generated environment secret is not committed. No release images are pushed and no production deployment is performed.

## Operational policy
`packages/db/src/queues.ts` owns a single, explicit V1 queue policy: at most 3 retries, exponential backoff starting at 2 seconds capped at 60 seconds, 120-second active-job expiration, 14-day queued/retry retention, 7-day completed-job deletion. Every V1 queue has a separate `.dead` queue with **zero retries** and longer stored-job retention. Both sets are provisioned first/updated in dependency order so existing baseline queues receive the latest policy; doing so twice is safe. Existing already-enqueued jobs can still carry their original per-job retry/timeout fields; the queue policy governs future jobs, not a rewrite of historical ones.

Terminal failures and expired leases enter dead-letter queues; the source job ID/retry count and payload can be inspected using pg-boss (with protected access). No auto-redrive is performed. A human must investigate and explicitly authorize a later redrive when processors are live. Dead-letter jobs cannot become public catalog items. Queue stats may be cached and lag real job transitions; integration tests inspect claimed dead-letter jobs instead of treating a cached `queuedCount` as real-time truth.

### Exactly-once database effects, not exactly-once execution
`executeFolioJobOnce(db, identity, handler)` accepts **only** a recognized V1 queue, bounded operation key, UUID pg-boss job ID and SHA-256 of the canonical operation payload. `job_completion_receipts` has a composite primary key `(queue_name, operation_key)`. The unique insert, trusted handler's **database writes via the supplied transaction**, and `job.completed` audit record commit atomically. A retry/replay after commit returns `already-completed` and does not run handler effects; using the same key for another SHA-256 payload is rejected. A thrown handler error rolls back the receipt and business writes, records a sanitized `job.attempt.failed` audit entry, and propagates the error so pg-boss can retry. Receipts are durable and must not be deleted without a complete compatibility/migration plan.

**Important limitation:** this enforces at-most-once committed effects *inside the same PostgreSQL transaction*, not exactly-once handler invocation, network calls, or filesystem effects. Feature handlers MUST use the provided transaction for all durable business writes. File writes, notifications or any external side effects must use their own idempotent protocol/outbox and are not implicitly protected by this helper. An operation key and SHA-256 must be chosen from a stable, canonical manifest/import identity by the feature implementation; it cannot be a fresh random ID on every retry.

## Test evidence (Ubuntu `mehmet`, 10 October 2026)
- `bash infra/lab.sh migrate`: forward-only Drizzle migration creates the receipts table and preserves existing books/provenance/revisions.
- `bash infra/lab.sh test-db`: separate test database migration, FK/pg_trgm, atomic transaction rollback, and persistent singleton enqueue after pg-boss restart.
- `bash infra/lab.sh job-smoke`: policy applied/reapplied on all four queues; concurrent completion race yields exactly one DB effect; payload mismatch rejected; failed transaction rollback with audit; retry succeeds; real pg-boss worker throws twice and dead-letters with source ID/retry count/payload preserved; expired lease is supervised into dead-letter.
- `pnpm check`: packages build, TypeScript, lint, unit/integration and contract snapshots.
- GitHub CI additionally runs the isolated database test suite automatically on every PR and `main` push. Passing JavaScript bundles are not real Android/iOS native device tests; those remain V1-04 release acceptance.

## Commands
From `/home/mehmet/Projects/folio` on Ubuntu:
```sh
bash infra/lab.sh db-up
bash infra/lab.sh migrate
bash infra/lab.sh test-db
bash infra/lab.sh job-smoke
```
Do not run database reset/drop, `docker compose down -v`, production credentials, or force migration to an unverified database. Inspect/record failed jobs and queue backlog before enabling a real feature worker.
