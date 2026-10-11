# Kalite kapıları, güvenlik, CI, lab ve canlıya çıkış

## Temel prensip
Geliştirme ve otomatik testlerin ana yürütücüsü **GitHub-hosted Ubuntu Actions**; `mehmet` Desktop Commander yalnız isteğe bağlı yerel laboratuvar. Kod ve testler Folio-only izole CI/lab altında sentetik verilerle çalışır; **prod deployment yapılmaz**, prod yalnız bağımsız onay kapısından sonra. CI'da geçici gitignored lab secrets; canlı için ayrı secrets. GitHub Actions production runtime veya kalıcı DB değildir.

## CI / statik kalite
- Node LTS, corepack/pnpm lockfile; linters, TS strict, format, dependency vulnerability/licensing scan, config validation, conventional migrations.
- Unit: work-matching, rights gate, passport/auth, policy visibility, parser semantik blok testi, RSVP tokenizer, progress conflict resolver, import manifest/checksum.
- Integration: Postgres test DB (migrations, RLS/ACL at app boundary), file fixtures, import idempotency, API auth/permission, media storage ACL, admin mutation audit.
- API contract: OpenAPI schema diff, pagination/sort/filter, 4xx errors stable codes, localization texts and rate limit. Error logs redact secrets/PII.
- E2E: Android, iOS (Mac build/test gerekirse ayrı koşum), browser Chromium/Firefox/WebKit, mobile narrow, tablet portrait/landscape, desktop widths, keyboard and reduced motion.
- Automated visual screenshots/golden diffs for key routes; no unapproved layout divergence from reference tokens; RTL out of scope unless language added.

## Uçtan uca kabul senaryoları
- Register/login/email verify/reset/logout/revoke devices/admin MFA; unauthorized guest cannot read user private books; cross-tenant access negative tests.
- Friendship QR/deep-link/code only; no person search endpoint; invite expires/revoked/rate-limited; blocked users cannot view protected data.
- 1.000 eser curated pilot: 500 TR + 500 EN candidates, no assumption all instantly publishable. 100 QA test books mixed formats (valid EPUB, fixed-layout EPUB, searchable PDF, 2 column PDF, image only/DRM), 20 translations, 20 ready audio and corrupt fixtures.
- OCR never invoked; invalid files get localized helpful error; classified footnotes/page numbers never appear as RSVP token/audio narration when excluded, source remains intact.
- Normal reading fonts/dark mode/position; 320 WPM vs other speed; group size; pause/resume, chapter transitions, punctuation, last-token/off-by-one.
- Audio chapter seek, playback after background, sleep timer, language variant switching, missing segment, corrupt audio/codec fallbacks.
- Cross-device block/token cursor with conflicting writes, revisions, translation 1:N, offline/resume, QR links web fallback/mobile deep link.
- Personal uploads private: no work-based matching that reveals private text or pre-generated audio to others; global license gate.
- Admin every CRUD: validation, preview/diff, double confirm risky mutations, audit reason, roles; import idempotent/dry-run/resume/export scope.
- Cover full set: long titles/accents/Dark/Light, generated typography only, no publisher cover replication.
- Analytics daily/read sessions/wpm/streak accurate timezone, background/idle exclusion, deleted-account purge, privacy opt-out.
- Accessibility: WCAG 2.2 AA target, meaningful labels, keyboard tab/focus traps, VoiceOver/TalkBack, readable contrast/font scale, layout zoom.
- Load/safety: 1K catalog query p95 target defined in benchmark issue (measured, not invented), concurrent read requests, upload storms, large files, slow client; job concurrency throttles and disk alarms.
- Performance/readers: web first-load size, asset lazy load, memory spikes on 500+ chapter books; mobile low-memory fallback.
- Disaster recovery: DB backup + offsite blob backup + documented actual restore into fresh stack; RPO/RTO measured; import/export != DR backup.

## Lab machine and deployment
- Birincil laboratuvar GitHub-hosted Ubuntu Actions CI, ayrı `folio_lab` Compose project ve yalnız sentetik test verileridir. `mehmet` Linux Desktop Commander cihazı isteğe bağlı ek test makinesidir; çevrimdışı olması Actions CI'ını engellemez. Repo device ID, SSH address veya token tutmaz.
- Use separate ./infra/compose.lab.yaml and lab.env secret external; no cross-environment DB mount. GitHub Actions `validation=fast` hızlı geliştirme; `validation=full` tam regresyon içindir. Desktop Commander veya yerel gh CLI isteğe bağlıdır. Do not modify unrelated Docker stacks; reserved ports, prefix project folio_lab.
- Lab smoke: local HTTPS/proxy, health endpoints, migrations, insert fixture work+author, import sample package, reader retrieve, progress write, two devices sync; nightly backup and restore test.
- Production readiness checklist: security review, country-by-country rights sample review, restore proof, monitoring, incident runbook, stable performance, Android/iOS/Web E2E, release artifacts/review, explicit deploy approval.
- Live: separate VPS when authorized. Avoid live testing on production users. Zero-downtime migration desirable, but don't add cluster until metrics justify.
