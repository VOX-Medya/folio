# #26 | MVP protected editorial source read

The source written by `folioctl apply` in #19 remains an unapproved DRAFT. The asset has `owner_scope=catalog`, a generated UUID storage key, and `status=pending_verify`. It is **not** a public media asset, an approved rights grant or a playable book.

## API (not public)

`GET /v1/admin/catalog/works/:workId/editions/:editionId/revisions/:revisionId/source`

- Needs `FOLIO_ADMIN_CATALOG_HTTP_MODE=direct-tls-only`, real application TLS, a verified native bearer or same-origin secure web session, a current same-device MFA proof and `catalog:read` in PostgreSQL.
- Needs an explicit absolute `FOLIO_PRIVATE_STORAGE_ROOT`. Never accept this root, key, owner or source path from client input.
- Checks exact work / edition / draft revision / provenance / media asset ID, catalog owner and SHA-256. The adapter opens the opaque private inode with `O_NOFOLLOW`, checks mode `0600`, single link, size (max 1 MiB), digest and inode consistency.
- Returns only `{revisionId,sha256,sizeBytes,sourceText}`, with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. It never returns storage keys, filesystem paths, private-user bytes, or source claims as rights approval.
- A signed-in non-admin gets 403; unknown or mismatched scope gets 404; corrupt/changed bytes fail closed with 503. Anonymous requests get 401. No public `/media` or automatic publish endpoint is introduced.

## GitHub-hosted Ubuntu verification

The existing `pnpm test` runs LocalStorageAdapter owner/hash/permission tests. `bash infra/lab.sh import-smoke` exercises a real Folio-only PostgreSQL package and the MFA-backed private source read. The existing `bash infra/lab.sh admin-catalog-https-smoke` now exercises the protected HTTPS API with a synthetic private draft, anonymous/guest/wrong work/HTTP and tampered bytes negatives.

Follow-up #23 owns review and publication; #16 owns prepared audio attachment and delivery. Until explicitly completed, **these remain unavailable**. No production deployment or personal EPUB/PDF upload.
