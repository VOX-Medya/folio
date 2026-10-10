# #26 Quarantine byte lifecycle and conservative private orphan retention

## Implemented local-only boundaries

`LocalStorageAdapter.stage` opens an exclusive `0600` random-UUID `*.part` file **inside the Folio-only private volume**. It streams and hashes actual bytes, rejects invalid size, MIME admission and UTF-8 data as applicable, calls `fsync` on the writable file, closes it, and creates the final `*.blob` hard link **exclusively** so an unexpected pre-existing filename cannot be overwritten. The temporary name is removed, the owning directory is `fsync`ed, and only then is a `pending_verify` result returned. On normal errors the partial file and any final link created by this invocation are removed. Crash between creating the final link and removing `*.part` can leave both entries referring to the same inode; that file is **never auto-reclaimed when `nlink!==1`**. Crash after file completion but before DB commit can leave a valid unreferenced `*.blob`; the cautious orphan sweeper handles that case.

**Important:** A correctly staged quarantine file is not malware-scanned, a parsed EPUB/PDF, validated audio, granted country/edition rights, `verified`, or publicly accessible. No private download/upload HTTP endpoint, scheduled cleanup, provider service, or production deploy is added.

## Internal, per-owner cleanup (opt-in only)

`sweepPrivateQuarantineOrphans(db,storage,trustedOwnerId, options)` is exported as an **INTERNAL trusted backend service**, not an HTTP endpoint, cron job, or user-input path. The default mode is **dry-run**, with counts only and no raw key or filesystem path in the result. `apply:true` must be chosen by an authorized operator/worker **after** database, storage, backup, and deployment decisions have been made. This PR runs actual deletion **only on isolated synthetic test files inside the disposable GitHub Actions test vault**. It does not execute cleanup on any real private volume.

The caller provides a validated UUID **from a trusted principal/operator**, not HTTP headers. Cleanup:

1. Starts a PostgreSQL transaction and obtains `pg_advisory_xact_lock(hashtext(ownerId))`, the exact same lock as quota reservation and quarantine commit. Any **unexpired reserved** quota row blocks the entire owner's cleanup, including a reservation racing through a separate database pool.
2. Retrieves **all** `media_assets` keys for the owner, with *every* status (including rejected/deleted) protected against physical deletion. It does not make publication/rights judgments or release committed quota.
3. Scans only `quarantine/users/<validated-owner-UUID>`, max **512 directory entries per invocation**. It ignores catalog storage, other owners, `*.part` (including crash leftovers), unusual filenames, symlinks, unsafe/hardlinked inodes, insufficiently private permissions, wrong Linux UID, too-large/small files, and newly touched data.
4. Only an unreferenced lowercase UUID `*.blob` with `nlink===1`, `0600`, trusted UID, positive bounded byte count, and **all** birth/metadata-change/modification times older than **72 hours** is eligible. It checks file identity twice with `O_NOFOLLOW`. The advisory lock stays held while unlinking so valid quota admission and metadata commit cannot interleave.
5. Returns `dryRun,scanned,referenced,eligible,removed,skipped,truncated,blockedByActiveReservation` counts. Repeated runs are idempotent, the fixed per-run bound prevents unbounded directory processing, and unexpected I/O fails closed instead of scanning another location.

**Limitations:** `*.part` remnants, hardlink pairs after a process crash and symlink/special-file anomalies are **left for explicit forensic/manual review**, not silently destroyed. This is not a general retention rule for rejected/deleted *registered* assets, does not alter quota state or legal access flags, and does not implement full crash-safe DB/FS transactions. A compromised process running under the same Node UID can interfere with the local vault; operational volume isolation, backups, trusted workers and process permissions remain necessary. `testNowMs` exists **solely for synthetic ephemeral fixture clock advancement**; it must never be populated from untrusted requests or normal production configuration.

## Reproducible automated acceptance evidence

`packages/db/src/local-storage.spec.ts` checks a streaming pause exposes only `*.part`, final single-link `0600` byte integrity, dry-run vs apply, 72h clock, DB-key-protected records, wrong-owner and catalog isolation, symlink/hardlink/malformed-key refusal, incomplete file preservation and idempotent repeated deletion.

`bash infra/lab.sh storage-quota-smoke`, run by existing GitHub Actions CI **only** against the Folio loopback `folio_test` database, tests:
- Real dual-pool concurrent 70+70 quota reservation, digest, expiry, replay and owner isolation.
- A concurrent live quota reservation and owner-GC race serialized by PostgreSQL advisory locks (the cleanup reports `blockedByActiveReservation`).
- Reporting an unregistered **recent** file without deletion, explicit dry-run and synthetic 5-day clock advancement, deletion of exactly one old orphan, repeat cleanup idempotency, and survival of registered private, other user and catalog blobs.
- `media_assets` stays `pending_verify`; no user books, rights decisions or live filesystem bytes are changed.

## Remaining blockers

No deployment is safe until malware scanning, complete EPUB/PDF content verification, audio codec/duration validation, scanner-bound immutable proof and atomic authorized promotion, robust multi-process retention policy, session/RBAC/rights/territory-gated streaming Range/TTL, production backups and native-device tests are independently implemented and proven. The separately blocked `#7` dependency release gate stays mandatory. **#26 remains OPEN/BLOCKED** until its full acceptance criteria pass.
