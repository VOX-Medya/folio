# #35 | Rights-checked prepared audiobook playback (MVP Web)

- Attach **one** operator-prepared Ogg Opus or M4A voice before publication using
  the existing MFA-controlled `folioctl attach-audio` for a single-book draft.
- One deliberate MFA `publish` under the existing minimal admin workflow
  promotes the attached audio variant and immutable media asset only when the
  latest approved rights at work + edition + revision scopes independently
  allow **both display and audio** for the server-owned territory. A missing
  audio grant leaves the voice private and the text may still publish.
- The publication transaction revalidates a catalog-owned private 0600 file,
  its exact length and SHA-256, its immutable source chapter/block SHA, and
  records `audio.prepared.publish` with real actor and request ID. Publication
  is not an automatic transcoder, codec certification or license claim.
- `GET /v1/catalog/audio/{revisionId}/{chapterId}` is HTTPS-only and
  unconditionally rechecks current publication, latest three-scope **display
  plus audio** rights, verified source provenance and the selected verified
  media attachment. Every request reads the trusted private inode via
  `O_NOFOLLOW`, rechecks ownership/mode/size/SHA and never serializes a
  storage key. Publicly approved media supports one bounded byte Range
  (`206` and `Content-Range`), with `404` for missing/withdrawn/foreign
  chapters and `503` for changed bytes.
- Expo Web reader offers normal/RSVP/audio modes with actual HTML media
  play/pause, 10-second seek, adjustable rate and next-chapter. Missing
  approved audio produces an explicit error; no fabricated sample or
  unauthorized fallback asset is played. Native app JS exports remain built,
  but real Android/iOS audio controls and device/codec certification are
  **NOT** claimed and must be completed before release under #48.
- Files stay Folio-only; 16 MiB is the first single-chapter verified media
  bound. Longer recordings need separately reviewed chunked media support
  AFTER-MVP. No user upload, TTS, offline download or background player.
- Synthetic Folio-only PostgreSQL + HTTPS smoke and Chrome playback
  evidence are required before this issue can close. Production needs human
  review of actual content rights and release/security advisories (#48).
