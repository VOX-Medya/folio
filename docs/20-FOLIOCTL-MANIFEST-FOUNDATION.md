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
pnpm --filter @folio/folioctl test
```

The preparatory folder is bounded by per-file and total size limits, and symlinks, special files, traversal/absolute paths, unexpected files, duplicated index paths and mismatched hashes are rejected. An existing output archive/symlink is never overwritten. The source folder is not modified; build copies to a temporary staging directory, revalidates it, writes SHA-256 checksums and creates a deterministically ordered tar.zst with normalized timestamps/owner/group. The archive is not automatically extracted or imported.

## Explicit unfinished acceptance
- Strict `pack validate` **for untrusted tar.zst archives**, including decompression-bomb, pax path and link abuse protection.
- Semantic validation of all metadata/JSONL domain IDs and references against the work/edition/revision schema; editor rights review and multilingual/audio source integrity.
- Authenticated export by work ID or approved library scope; private user files must never leak.
- Shared back-end `dry-run`, resumable idempotent apply and full audit (#19); currently no import or export commands are enabled.

No full #18 completion claimed. Test fixtures are synthetic and contain no book corpus.
