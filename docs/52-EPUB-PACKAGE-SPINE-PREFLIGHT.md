# Folio #20/#26 EPUB package and spine *relationship-only* preflight

## Security boundary

The earlier [ZIP preflight](./51-EPUB-STRUCTURAL-PREFLIGHT.md) checks only ZIP/OCF structure. This step uses the **CRC-validated, bounded decompressed entries**, without filesystem extraction, to inspect `META-INF/container.xml` and its single canonical OPF package document. It does **not** open, parse or render XHTML book chapters. No OCR, rewritten/generated sentences, remote resource fetch, published text, external catalog/sync, user-visible HTTP upload/download route or media state transition is introduced.

`inspectEpubZipPackageSpine(bytes)` is an opt-in internal extension: the existing `inspectEpubZipStructure` still returns `structure_only` and has unchanged behavior. An accepted package/spine relation returns `package_spine_only` with counts, not private file paths, source XML, text or permission to publish. Every media record continues to be `pending_verify`, even if both ZIP and package checks and a synthetic virus scanner pass.

The intentionally conservative XML reader accepts only a **small, bounded XML 1.0 subset for container + OPF metadata**: at most 256 KiB per metadata document, 1,024 XML nodes, 16 stack levels and 8 KiB markup tags. UTF-8 decoding is fatal on malformed bytes. It rejects DOCTYPE, ENTITY declarations, processing instructions other than the initial XML 1.0 header, XML comments, CDATA, arbitrary or numerical entity references, duplicated attributes, namespace rebinding and `xml:base`/external xlink references. This is deliberately **not a general XML parser** and may refuse unusual but legitimate EPUB metadata.

This preflight checks:

- Exact `container` namespace/version and **one** `rootfiles/rootfile` declaration of MIME `application/oebps-package+xml`. Multiple rendition selection, remote or missing `full-path`, percent-encoding, traversal, absolute paths and inconsistent case are rejected.
- Package root namespace `http://www.idpf.org/2007/opf`, `version="3.0"`, and direct `metadata`, `manifest`, `spine` elements in the expected order.
- No duplicate manifest IDs or item paths; a local, existing ZIP member with an allowed conservative suffix/MIME must match each manifest item. Relative links are resolved from the package directory and disallow `..`, `.`, external URI schemes, queries/fragments, percent escapes and ambiguous paths.
- At least one navigation XHTML document marked with exactly one `properties="nav"` token and at least one **linear** `spine/itemref`; every itemref must be unique and resolve to an XHTML manifest item. Unsupported `scripted`, `remote-resources`, inline fallback or unknown properties fail rather than silently weakening the gate.
- Every non-container ZIP member must be accounted for by the package manifest, preventing hidden/unlisted XHTML. Unsupported active SVG/script formats are refused at this stage. Limits: 256 manifest items and 128 spine references; the existing 16 MiB archive, 512 ZIP entry and expanded byte caps remain.

**No text extraction, EPUB navigation rendering or safety claim follows from this relationship check.** Especially not yet checked: actual `dc:` metadata semantic validity, `nav.xhtml` or chapter XHTML DOM, script and remote resource sanitization, chapter order within a column/page, cross-language alignment, CSS and font integrity, Dublin Core rights provenance, safe PDF text-layer reading, malware freshness or file publication. A malicious XHTML chapter can pass `package_spine_only`; this is **expected** and explicitly tested. File import/UI must continue to show `Dosya yapısı desteklenmiyor` when any mandatory future gate fails; no guessing or AI correction.

## State / concurrency / audit

`LocalStorageAdapter.inspectEpubPackageSpine` is PRIVATE: it first reads the only trusted, owner-scoped `pending_verify` `.blob` using `O_NOFOLLOW`, verifies 0600/UID/single-link inode, source SHA-256 and byte count, and rejects changed ctime/mtime or swapped file identity. `observePrivateQuarantineEpubPackageSpine` sources the owner/key/MIME/digest/size strictly from the persisted `media_assets` row, runs bounded parsing **outside** a long DB transaction, rechecks metadata/state under the same per-owner PostgreSQL advisory transaction lock used by quota, scanning and orphan cleanup, and rejects concurrent withdrawal/metadata changes.

Only a generic `storage.quarantine.epub_package_observed` audit event is persisted, with `package_spine_only`, counts, digest and `pending_verify` state. Private storage keys, XML/OPF paths and actual source text are **never** included. Cross-owner/unknown assets have no observation. No `verified`, `published` or `rejected` mutation, remote storage provider, Range/TTL media route or production deployment is added.

## Reproducible checks and open blockers

`packages/db/src/epub-structure.spec.ts` adds synthetic complete EPUB OCF fixtures with versioned container.xml, OPF metadata/manifest, nav document and linear chapter. Negative cases include fake-but-CRC-valid XML, XML external entities and custom references, namespace substitution, remote base/manifest paths, unlisted XHTML, duplicate IDs/references, wrong MIME, missing navigation, no linear chapter, XML truncation and unsafe properties. Every result is explicitly limited to `package_spine_only`.

`bash infra/lab.sh storage-epub-smoke` uses ONLY the disposable Folio PostgreSQL `folio_test` and private synthetic ZIP bytes, with two independent database pools. It verifies owner-only package evidence, private-key and content non-disclosure, malformed OPF refusal despite valid ZIP structure, no DB `verified` mutation and withdrawn assets producing **zero** success audits after a concurrent mid-parse reject. The existing ZIP structural, ClamAV synthetic-signature, HTTPS/PG, Expo JavaScript three-target, Chrome E2E, license, no-deploy Docker and dependency evidence gates must remain unchanged.

References: [W3C EPUB 3.3 OCF rootfile/OPF specification](https://www.w3.org/TR/epub-33/#sec-ocf), [EPUB Package Document](https://www.w3.org/TR/epub-33/#sec-package-doc). Production **BLOCKED** by #7 and #26. Complete EPUB source parsing, safe HTML, security scanning with current official signatures, actual file promotion, territory/owner/RBAC media API and native-device QA remain separate mandatory gates.
