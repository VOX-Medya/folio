# Folio canonical author/work foundations (#12)

## Implemented draft schema
Forward-only Drizzle migration `0001_public_ben_urich.sql` adds author aliases, global source-scoped external author IDs, multilingual work titles, distinct edition IDs, edition contributors (including translators) and per-edition identifiers (including ISBN). The existing UUID work, author and work-author join remain intact, and title/ISBN are **not globally unique identifiers**. Edition and translation variants belong to one canonical work but are never collapsed to the same edition ID.

## Internal transactional commands
`@folio/db` exports `createCanonicalAuthor`, `createCanonicalWork`, and `getCanonicalWorkDetails`, validated against typed `@folio/contracts` inputs. Work creation requires at least one author and cannot publish a book: every new work and edition is explicitly `draft`. Related author/edition/title/identifier rows and the audit record are written in the same DB transaction. A broken contributor foreign key rolls back the entire operation. No unauthenticated public author/work CRUD endpoint has been exposed, and there is **no people-search API**.

Source rights, country access policy, manual publication approval, full content revision model and actual admin CRUD are subsequent issues (#13-#23). Duplicate match suggestions based on source hashes/human review are also separate import work. No automated external source, OCR or AI generation runs here.

## Real Ubuntu DB evidence
`pnpm check` PASS including lint, strict TS, unit/HTTP, build, design matrix and OpenAPI. `bash infra/lab.sh migrate` PASS on existing lab DB with forward-only migration. `bash infra/lab.sh test-db` PASS on separate Folio-only `folio_test` DB. `bash infra/lab.sh catalog-smoke` PASS: test fixtures include aliases/external source IDs, N:M work authors, two TR/EN editions with distinct contributors, same ISBN in distinct editions, two works with the same title but unique UUIDs, FK failure rollback and corresponding audit record. All fixture works remain draft; no catalog/public URL exposes them. `folio_test` stores synthetic records for repeatable diagnostics only; never real user data.

This is partial #12 until authenticated admin workflows, rights-aware read/search, responsive UI and all acceptance tests are finished.
