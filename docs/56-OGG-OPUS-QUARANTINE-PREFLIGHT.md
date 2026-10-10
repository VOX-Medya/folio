# Folio #26 / #16: Ogg Opus private quarantine-only preflight

This change inspects a narrow **single logical serial, one-packet-per-page Ogg Opus** container subset. It does NOT produce or publish audio, decode frames, certify codec integrity, prove audible duration, authorize downloads, access external providers or alter any existing media status.

## Internal API

- `inspectOggOpusContainer(bytes)`: bounded byte-only structure observation, no returns of source bytes, Ogg serials, vendor strings, packets or filenames.
- `LocalStorageAdapter.inspectOggOpus(record)`: only previously persisted private 0600 O_NOFOLLOW single-link inode with matching UUID owner, MIME, byte count and SHA-256; capped at 16 MiB; before/after inode attributes revalidated.
- `observePrivateQuarantineOggOpus(db, storage, trustedOwnerId, assetId)`: owner-scoped PostgreSQL lookup of pending_verify `audio/ogg`, file inspection outside transaction, owner advisory lock and identical storage key/hash/size/MIME/duration/status/verifiedAt recheck. Writes only aggregate counts and `granuleTimelineMs` under action `storage.quarantine.ogg_opus_observed`. No successful audit on mid-inspection withdrawal.

## Deliberately narrow supported Ogg features

Input <=16 MiB, <=4096 pages, <=64 KiB per complete packet/page. All pages require correct OggS capture, version 0, checksum CRC-32, monotonically sequenced pages starting at 0, exactly one stream serial, no page continuation and no chaining or multiplexing. First page BOS and exact 19-byte OpusHead version 1, 1 or 2 channels, 48 kHz original input rate, zero gain, mapping family 0 and bounded pre-skip. Second page has OpusTags, bounded vendor length and zero comment entries. At least one nonempty following audio packet, monotonic granule positions, exactly one final EOS page with no trailing bytes. Granule timestamp <=12 hours, computed review-only granule timeline ms.

It intentionally rejects valid multi-packet Ogg pages, page-spanning packets, multi-stream Ogg, embedded comments, alternate gains/sampling rates and larger inputs until separately reviewed. **No Opus frame decoding or packet duration validation is performed.** A forged granule can still lie about duration, so `granuleTimelineMs` must never be treated as a verified audible duration, used for approved segment timestamps or promoted to verified state.

### Tests

Synthetic unit cases: full valid three-page Ogg/Opus header/tag/audio chain, invalid header, Ogg CRC bit flip, missing EOS/BOS, swapped serial/sequence, wrong OpusHead/Tags, oversized vendor/packets, unknown flags, spoofed granule, appended bytes and forged re-encoded page CRC. Separate isolated Folio-only two-pool PostgreSQL smoke checks owner isolation, auditable count-only evidence, quarantine status preservation, malformed container denial, in-flight withdrawal and no success audit.

Existing `pnpm check`, Folio-only smoke chain, Expo Web/Android/iOS JavaScript exports, Playwright, CodeQL and CI Docker non-deploy build remain required. Local desktop native validation and official fresh ClamAV signatures are not supplied by the GitHub runner.

**Still open**: M4A/MP4 container parsing, actual codec/frame verification, scanner freshness, proof-bound atomic verified promotion, actual secured signed/RBAC/territory Range reader, iOS/Android devices and #7 advisories. Private status remains `pending_verify` even on a positive result. The presence of `audio/ogg` in staging has NEVER implied playback approval.
