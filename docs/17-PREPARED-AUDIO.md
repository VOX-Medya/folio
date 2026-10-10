# Prepared audiobook variant baseline (#16)

## Versioned local-asset contract
The `media_assets` table registers catalog-owned, private-key, size, SHA-256, mime (`audio/mp4` / `audio/ogg`) and duration metadata. Newly submitted metadata is **pending_verify**, not a playable or legally approved file. The dedicated private storage adapter (#26) must stream and hash actual bytes before any asset is exposed. No TTS provider or automatic voice production is present.

`audio_variants` identifies an immutable prepared-audio rendition by source content revision, language, named voice, codec and variant version. Each new segment replacement creates a full new `draft` variant pointing at the predecessor through `supersedes_variant_id`. Old variants, segment IDs and prior asset pointers remain available to existing listeners; no update/delete of source media rows is performed. `audio_segments` maps chapter, ordinal, text block UUID and exact source SHA-256 to a prepared media asset, enforcing source-revision ownership, `includeAudio` consent, segment chronology and declared file duration/codec.

Operations are internal until secure RBAC, actual upload, verified file checks and rights-aware playback are available in V1 issues #22/#26/#35. Successful metadata registration **does not** imply the audio has been rendered, synthesized, verified, published or played. No public audio endpoint exists yet.

## Real Ubuntu test evidence
Forward-only `0005_simple_sumo.sql` applied to `folio_lab` and separate `folio_test` DB. `pnpm check` passed lint/typecheck/unit/build/OpenAPI. `bash infra/lab.sh audio-smoke` passed on synthetic metadata: exact text block hash/codec/duration checks, append-only v1→v2 replacement, old listener segment references preserved, unchanged segment retained, unknown variant gracefully absent, audit and draft-only state. The simulated file hashes/keys in the fixture are **not real uploaded media**. Private adapter checksum verification remains pending and is not bypassed.

Real playback, codec/duration sniffing against file bytes, file upload/replace UI, offline caching, chapter/segment seek and device background audio E2E are still outstanding; keep issue #16 open.
