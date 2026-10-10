# Folio #20/#26/#46: Embedded EPUB binary quarantine preflight

## Fifth independent stage, deliberately conservative

This change follows bounded OCF ZIP CRC, exact OPF manifest/spine, strict XHTML, and inert CSS resource inspection. `inspectEpubZipPngResources` first reruns all four established stages, then checks the bytes of *every remaining OPF manifest resource*. Only a small **nonanimated PNG structural subset** is admitted. `image/jpeg`, `image/gif`, `image/webp`, all OTF/TTF/WOFF/WOFF2 fonts, NCX and other non-XHTML/CSS resources are explicitly **rejected**, not treated as verified. No image/font decoder sandbox has been implemented.

The PNG lexical/structural check requires:

- Exact PNG signature, single first 13-byte IHDR, one or more contiguous IDATs and a final, empty IEND, with no trailing bytes and no unknown or ancillary chunks.
- CRC32 on each chunk; no palettes, profiles, text, EXIF, APNG or other metadata.
- 8-bit RGB/RGBA, compression method 0, filter method 0, no interlace; pixel rows checked for valid PNG filter bytes 0-4 after bounded zlib inflate.
- <=16 images, <=1 MiB per compressed PNG, <=4 MiB total PNG bytes; dimensions <=2048 per axis, <=1,048,576 pixels each and <=2,097,152 pixels total; <=64 PNG chunks. The decompressed scanline buffer is constrained to the exact expected length and <=100:1 inner expansion ratio. Compressed stream consumption is verified, rejecting trailing streams/data.

A positive `png_structure_only` result returns only `imageCount`, `imageBytes` and `totalPixels`. It **does not mean safe to render**. No browser displays the image: the XHTML subset currently rejects `img`, `picture`, `svg`, `style`, `link` and inline styles. Original publisher covers are never exposed as Folio standard cover art.

## Owner/security boundary

`LocalStorageAdapter.inspectEpubPngResources` reuses trusted owner, 0600, O_NOFOLLOW, single-link inode, byte length and SHA-256 private quarantine checks, without exposing files or byte streams. `observePrivateQuarantineEpubPngResources` takes a trusted principal and persisted private media UUID, refuses any non-`pending_verify`/mismatched MIME/owner, checks all content outside a transaction, then revalidates unchanged storage key, digest, size, status, duration and null verifiedAt under the per-owner PostgreSQL advisory lock.

The audit action `storage.quarantine.epub_png_observed` records only SHA-256, `png_structure_only`, image count, byte count, pixel count and unchanged `pending_verify`. No raw storage key, filename, path or source text. Revocation during inspection produces no success audit. Nothing becomes verified, playable or published. No HTTP/static API, image URL, renderer, decoder installation, remote fetch, automatic cleanup, or production deploy.

## Validation

Synthetic unit test corpus exercises a tiny valid RGBA PNG, missing/forged signature, truncated or appended bytes, invalid CRC, unknown/APNG/metadata chunks, invalid dimensions/color/filter, corrupt zlib stream, incomplete/extra deflate data, unsupported GIF/JPEG/WebP and font MIME, oversized/dimension limits, no-binary EPUB, and private owner/digest denial. Real Folio-only, two-pool PostgreSQL smoke covers owner isolation, status preservation, minimal audit, malformed/unsupported embedded binary denial and mid-inspection withdrawal. CI also runs the preexisting unit, integration, browser and Expo JavaScript export checks, synthetic ClamAV test and local nondeploy Docker image.

**Still required before any safe renderer or verified status:** hardened binary format-specific decoder sandbox and font parser, semantic reliable EPUB text/provenance, PDF and audio text/codec parsing, current official antivirus definitions, atomic multi-proof verification, authenticated RBAC+territory+rights media Range/TTL/revocation API, native device QA and the independent dependency release security gate (#7). Strict rejection of valid complex EPUBs is deliberate, not an implicit rewrite. Do not bypass/waive gates or publish content.
