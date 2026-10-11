# #16 | Minimal prepared audio attachment (draft only)

The single-book `folioctl apply` workflow from #19 first creates a private
draft from a manifest containing exactly one UTF-8 text asset. New imported
paragraphs are marked `includeAudio:true` so an externally recorded voice can
refer to the original immutable chapter and text SHA without modifying it.

## Attach one manually prepared voice file

Create a SECOND manifest JSON with the same `schemaVersion`, `packageId`,
`book.title`, `book.language`, `book.editionLabel` and original `text`
file metadata. Add one `files[]` entry of `kind:"audio"`, containing a
package-relative `.ogg` or `.m4a` path, the exact real SHA-256 and byte size.
The second manifest's checksum changes, but the imported package ID and text
SHA must still match the committed source. Do not run `folioctl apply` against
the two-file manifest.

```bash
pnpm --filter @folio/contracts build
pnpm --filter @folio/db build
# The following are only used in a GitHub Actions isolated Folio lab:
export DATABASE_URL="postgresql://folio_lab:<local-secret>@127.0.0.1:55432/folio_test"
export FOLIO_ADMIN_BEARER="<current-MFA-audio-admin-session>"
export FOLIO_PRIVATE_STORAGE_ROOT="<absolute-0700-private-Folio-directory>"
pnpm folioctl attach-audio ./prepared-book-with-audio/manifest.json 8000
```

Duration is provided in milliseconds as **operator-reviewed declared metadata**,
not automatically measured media duration. No TTS/OCR, transcoding, public
download, audio playback, approval, or user upload is involved.

## Boundaries

- `validatePackage` verifies every original and prepared file's path, byte
  count and SHA. The source is opened with `O_NOFOLLOW`, then streaming SHA
  and private 0600 inode checks run again while staging.
- Active same-device MFA plus persisted `audio:replace` role is required.
  The DB transaction checks the original applied package receipt, its payload
  digest, author/work/edition identities, source revision SHA, and exact
  chapter/block anchor. Another owner, unpublished source mismatch or
  unauthenticated caller cannot create an asset.
- A single `prepared.manual` variant is created as `status:draft`.
  Its `audio_segments` entry links the verified text SHA to private
  `media_assets.status=pending_verify`. The voice file is **not** treated
  as playable, virus-cleared, licensed, verified or published by this step.
  Additional codec/content review and rights approval remain required at #23,
  with user-facing audio playback following at #35.
- No public stream route or signed URL is created; neither path nor key is
  exposed to consumers. A second attachment cannot overwrite the original.

The Folio-only PostgreSQL `bash infra/lab.sh import-smoke` runs synthetic
positive and negative cases (MFA denial, changed bytes/sha and repeat attach).
These tests run on GitHub-hosted Ubuntu. Production release is reserved for #48.
