# Folio pack v1 partial CLI foundation (#18)

## Input layout and manifest
This is a CLI for editor-prepared local content; it neither downloads content nor creates translations, audio or prose. Prepare a directory containing:

```
manifest.json
metadata/authors.ndjson
metadata/works.ndjson
metadata/editions.ndjson
metadata/revisions.ndjson
metadata/rights.ndjson
texts/<revision_uuid>/blocks.jsonl  # optional, only if declared in files index
```

`manifest.json` must match `tools/folioctl/manifest-v1.schema.json`: `schema_version:"1.0.0"`, a package UUID, ISO creation time, `source:"local-editorial"`, `scope:"licensed-library"`, declared author/work/edition/revision counts, tool name/version, and `files` array of `{path,sha256,size_bytes,kind}` for each file except `manifest.json` and `sha256sums.txt`. All five named `metadata/*` files are required and indexed, including rights evidence. The index is a **hash declaration**, not evidence of publishing permission. Records are not inserted into the database by this CLI.

## Current safe commands (Ubuntu `mehmet`)

```
pnpm --filter @folio/folioctl exec node bin/folioctl.mjs pack validate --input ./prepared-books
pnpm --filter @folio/folioctl exec node bin/folioctl.mjs pack build --input ./prepared-books --out ./folio-batch.tar.zst
pnpm --filter @folio/folioctl exec node bin/folioctl.mjs pack validate --input ./folio-batch.tar.zst
pnpm --filter @folio/folioctl test
```

Both prepared directories and `tar.zst` archives are validated. An incoming archive is decoded with `zstd` and parsed with a streaming tar reader **without writing archive entries to disk**. Every decoded entry is constrained by path, type, size, entry count and total inflated-byte limits; symlink/hardlink/device entries, duplicated or unindexed files, unsafe PAX paths, modified digests and checksum-index inconsistencies fail closed. The archive includes a required `sha256sums.txt`. Output creation copies the verified staging archive using exclusive-create semantics; existing archive files or symlinks are never overwritten. The source folder remains untouched; tar entry names/owners/timestamps are normalized for reproducible output.

The versioned V1 metadata requires explicit author IDs and work authorship, edition/revision UUID ownership and language agreement, per-block verbatim UTF-8 SHA-256, stable block and chapter IDs with consecutive ordinals, and manually supplied pending rights evidence. Non-text footnotes, page numbers and publisher notes are disallowed from RSVP/audio. Packaged cross-language alignment edges must point to existing prepared blocks of the same canonical work; verified alignment claims and auto-published rights are not accepted as approval. Text and alignment JSONL are parsed **incrementally**, with line and total record caps rather than loading entire large source files. Invalid UTF-8 or forged block hashes are rejected, even if the outer package checksum was updated.

`sha256sums.txt` proves **internal package integrity, not provenance authenticity, editorial approval or a legal license**. Human review and rights validation remain a separate API/admin approval step. Import, public serving or publisher approval never happens during validation.

## Explicit unfinished acceptance
- Authenticated export by work ID or approved library scope; private user files must never leak. `folioctl export` is still disabled.
- Shared back-end `dry-run`, resumable idempotent apply and full audit (#19); `folioctl import` remains disabled.
- Verify on-disk raw source blob, real audio codec/duration and real rights before publishing; this metadata-only manifest validation cannot attest real media or legal ownership.
- Human editorial/legal signoff and real rights-aware API/admin integration E2E. Cross-batch references to prior imported revisions require the later database-aware import engine; this V1 preparatory package validator accepts only self-contained revision/alignment references.

No full #18 completion claimed. Test fixtures are synthetic and contain no book corpus.
