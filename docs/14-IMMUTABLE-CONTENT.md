# Immutable source and semantic content revisions (#13)

## Implemented foundation
Forward-only Drizzle migration `0002_lively_dazzler.sql` creates provenance, content revisions, chapters, and semantic blocks. Revision identifiers, stable chapter/block identifiers, chapter and block ordinals, verbatim source text, source locator, SHA-256 and independent normal/RSVP/audio flags are stored. The source asset key/hash is metadata only until the dedicated storage adapter verifies and preserves the raw bytes under #26. No OCR, text restoration, AI correction or synthesis occurs.

A strict `@folio/contracts` input validator rejects missing source text, duplicate IDs, gaps in reading order, foreign parent blocks, and footnotes/endnotes, page numbers, running headers, publisher notes or image refs enabled for RSVP/audio. `@folio/db` verifies the SHA-256 for each exact UTF-8 block, creates a separate draft revision and audit row in a transaction, and never updates source content in place. New revisions may reference their parent only when its edition matches; translations and sound files will link the exact revision in later V1 issues.

Postgres protection triggers reject changes and deletion of provenance, chapter and block records, and reject changes/deletion of content revision source identity. Revision status may be updated by future audited approval workflows, not in this foundation. Existing user reading cursor migration, diff editor, integrity review, rights and publishing checks remain incomplete and are **not** treated as delivered.

## Verified Ubuntu test evidence (10 October 2026)
`pnpm check` passed, including strict TypeScript, ESLint, build, unit tests, API contract and OpenAPI drift. `bash infra/lab.sh migrate` and `bash infra/lab.sh test-db` applied forward migrations in the dedicated Folio databases. `bash infra/lab.sh content-smoke` passed on the isolated `folio_test` database: two chapters and four semantic blocks, RSVP exclusions, exact verbatim source matching, creation of a distinct child revision while retaining original text, PostgreSQL UPDATE tampering rejected for both blocks and provenance, wrong checksum rejected, and an audit trail. Only synthetic draft text was used; no copyrighted book or public library publication took place.

## Acceptance still pending
Raw file hashing against actual private storage, EPUB/PDF extraction reliability gates, source-revision diff/editor, actor authorization through admin RBAC, revision-to-reader cursor mappings and cross-platform reader E2E. These are dependencies tracked in related #20/#22/#26/#33/#36 and release tests. Keep #13 open until complete acceptance rather than claiming broad completion from schema smoke tests alone.
