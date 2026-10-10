# Folio #20/#26: isolated EPUB CSS quarantine-only preflight

## Scope

This fourth internal preflight follows the bounded OCF ZIP, exact OPF manifest/spine, and inert XHTML/local-reference gates. It inspects only OPF-declared, CRC-checked CSS bytes. No network fetch, renderer, stylesheet injection, upload/download route, binary image/font decoding or metadata approval is added.

APIs: inspectEpubZipCssResources, LocalStorageAdapter.inspectEpubCssResources, and observePrivateQuarantineEpubCssResources. The storage adapter reuses the private O_NOFOLLOW, 0600, nlink=1, expected owner/key, SHA-256, byte length and inode-stability inspection. The database observation accepts only a trusted owner and persisted pending_verify private media UUID. Its advisory owner lock and status/digest/key/size/verifiedAt recheck ensure that an in-flight rejection cannot be recorded as passing.

A passing result is strictly css_resources_only with aggregate stylesheetCount, stylesheetBytes, ruleCount and declarationCount. The audit action storage.quarantine.epub_css_observed stores these counters, SHA and unchanged pending_verify state, not any source, title, pathname, storage key or CSS string.

## Conservative syntax

Up to 32 manifest-declared .css resources, <=64 KiB each, <=256 KiB combined, <=256 rules and <=2048 declarations. Zero declared CSS is permitted. Only strict UTF-8 ASCII input, simple tag or class selectors (8 per rule maximum) and fixed inert literal properties for color, font family/style/weight/size, line-height, alignment, decoration, text indent and bounded margin/padding lengths are accepted.

Fail closed for @import, @font-face, all at-rules, CSS url() functions, comments, escapes, quotes, external references, pseudo/attribute selectors, custom properties, !important, unknown property/value combinations, Unicode tricks, nested rules, malformed blocks and oversized input. No rewrite/repair. A conservative subset may reject legitimate EPUB CSS.

The previous XHTML inspector still rejects link, style and inline style attributes, so no CSS is rendered. This is NOT a sanitizer and does not approve any font/image binary declared by the manifest.

## Checks and release boundaries

Tests: existing EPUB ZIP fixture unit corpus expanded with positive counts, CSS-free OPF, remote imports/URLs, obfuscated syntax and grammar negatives, UTF-8 and byte bounds, storage inode/owner/hash access denial. The Folio-only two-pool PostgreSQL storage-epub-smoke covers cross-owner denial, successful minimal audit without verified status, malicious CSS rejection and mid-inspection withdrawal.

Still required for #20/#26 completion: hardened actual renderer, reliable text/provenance/footnotes/reading order, images/fonts and complex EPUB semantics, real PDF/audio parsers, official fresh ClamAV definitions, atomic multi-proof verify, rights/territory and RBAC session-controlled streaming with Range/TTL/revocation, Android/iOS native-device tests and the separate #7 dependency release-security gate. No production build, publish or deployment.