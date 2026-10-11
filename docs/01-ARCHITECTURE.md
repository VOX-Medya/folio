# Tek VPS mimarisi / deployment sözleşmesi

## Karar
**Node.js 24 LTS veya uygulamaya başlandığı tarihte desteklenen uyumlu Active LTS**, NestJS + TypeScript modüler monolit; Drizzle + PostgreSQL; pg-boss Postgres içi iş kuyruğu; Expo (iOS/Android/Web); React + Vite + Tailwind admin. Sürümler lockfile, Docker image digest ve CI ile sabitlenir. İlk işte destek matrisi doğrulanır.

## Monorepo
- apps/mobile: Expo Router, ortak ekran ve domain hook'ları, platforma göre Web/Native UI kabukları.
- apps/admin: React, Vite, Tailwind; aynı backend endpointleri, yalnızca admin yetkileri.
- apps/server: NestJS API + admin/statik web hosting/ingress, OpenAPI, RBAC, input validation, domain servisleri.
- apps/worker: aynı backend paketlerini kullanan kalıcı jobs tüketicisi, aynı Node dağıtımıyla mümkünse ayrı süreç.
- packages/db: Drizzle şeması, migrations ve seed fixtures.
- packages/contracts: API DTO, zod/JSON Schema veya OpenAPI üretim doğruluğu.
- packages/ui-tokens: sabit font, palette, spacing, state, responsive tokenları; web/native için uyarlama.
- tools/folioctl: Node CLI, şema doğrulama, manifest, paketleme, dry-run/apply/export.
- tools/book-parser: gerekirse Python subprocess, ePub HTML ve text-bearing PDF dönüştürme; ayrı API/mikroservis değil.
- infra: Docker Compose, nginx/caddy reverse-proxy uyarlaması, health, backup scripts, log rotation, runbooks.

## İlk üretim süreçleri
1. Proxy/HTTPS: mevcut reverse proxy yeniden kullanılırsa Folio proxy container'ı gerekmez; tüm bağlantılar HTTPS.
2. folio-app: API + statik yayın (admin web, kullanıcı Expo Web export ayrı route/host); Node.
3. folio-worker: Postgres iş kuyruğu; import/parsing/kapak render/medya doğrulama gibi V1 işleri.
4. folio-db: PostgreSQL, erişim yalnız özel Docker ağı; volume + WAL/backups.
5. dosya alanı: başlangıçta VPS'nin özel volume dizini, DB'de yalnız opaque storage key. S3 uyumlu sürücü ileride; mevcut asset ID değişmeyecek.

## Yalınlık & bağımsızlık
- Redis, RabbitMQ, Elasticsearch, Kubernetes, ayrı auth sunucusu, ayrı Python REST API, ayrı Postgres dış arama motoru yok.
- Bölümler: auth, profiles/privacy, catalog, authors, editions, content/revisions, licensing, personal-library, upload, reader/progress, stats, social/invites, moderation, media, imports/exports, covers, admin/audit, jobs/storage interfaces.
- Internal port sınırları: SourceAdapter, StorageAdapter, TranslationProvider, NarrationProvider, ClassificationProvider, NotificationAdapter. V1 sadece StorageAdapter Local, ImportPackageSource (dosya paketi) ve mevcut manuel AssetUpload kullanır. Diğerleri interface/spec/disabled feature flag; runtime provider çalıştırılmaz.
- Uygulama kodu DB içinde Postgres'e özgü özellikler kullanabilir; taşınması gereken şey deploy modeli, iş mantığı değil. Migration ve seed sürümlenir; kolon kaldırma önce compatibility planı gerektirir.

## API ilkeleri
- OpenAPI 3, versiyonlu /v1/ endpointleri; REST-first.
- Yetki: JWT/secure cookies stratejisi platforma göre doğru seçilir; admin role/permission kontrolü backend'de; horizontal privilege escalation test edilir.
- Dosya teslim: short-lived signed link veya auth-guard streaming. Özel kullanıcı dosyaları kamusal statik dosya alanına konmaz. Web'de CSP, no remote HTML/script/asset; ePub HTML sanitization.
- Client rate limit ve boyut/akış limiti; idempotency keys; değişikliklerde optimistic locking (revision / ETag).
- Auth Better Auth veya eşdeğer self-hosted çözüm, seçim implementation issue'sunda değerlendirilecek; parola saklama, email doğrulama, parola sıfırlama, oturum yönetimi ve admin MFA zorunlu.
- Bildirim: uygulama içi bildirimler V1. Cihaz push entegrasyonu ayrı V1 issue'da fizibilite/izin gereği ile belirlenir, üçüncü taraf sağlayıcı bağımlılığı açık tutulur.

## İşleme / CLI
- İçerik ayrıştırma CPU-bound işini API request thread'inde çalıştırma; pg-boss ve worker. V1 sadece yükleme, validasyon, EPUB/HTML veya metin PDF extract, yapısal temsil, import.
- Kod sınırı: metin bloklarını değiştiren generatif üretim **yok**; OCR **yok**; scanned/file unreadable ise reject.
- Yeterli kalite sağlanmayan EPUB/PDF kendi başına yayınlanamaz. User-upload özel ve share'dan bağımsız.
- Audio/translations sadece paket olarak içeri aktarılır; önceden hazırlanmış asset/sürüm ve model metadata'sı tutulur.
- Fazla büyük paketlerde parçalı import, checksum doğrulaması, retry ve idempotency.

## Ortamlar
- localhost: örnek veri, migration, unit test, hızlı geliştirme.
- ci/lab (birincil: GitHub-hosted Ubuntu Actions): her koşuda izole Folio Docker Compose ve ayrı `folio_test`, sentetik/dummy veriler, gerçek HTTPS/PostgreSQL ve browser E2E. Ephemeral runner production sunucusu değildir; native iOS/Android için ayrıca yetkili cihaz gerekir.
- optional local lab: `mehmet` Desktop Commander Ubuntu cihazı ek manuel doğrulama için kullanılabilir, ancak Actions CI'ının bağımlılığı değildir; adres/token/repo secret yayımlanmaz.
- production runtime: henüz atanmadı; ayrı gerçek sunucu/hosting, secrets, kalıcı storage ve DB, HTTPS ve offsite backup gerekir. GitHub Actions yalnız CI/CD orkestrasyonu yapar. Kullanıcı açık onayı olmadan production build/deployment yok.
- Test cihazı 7/24 açık olsa dahi prod ve lab ayrımı. Production'a taşırken clean deploy + migration + restore test gerekir.

## Kaynak ihtiyacı / kapasite
- Başlangıç tahmini: 8 vCPU, 16 GB RAM, büyütülebilir 250 GB NVMe (metin ve hazır seslerin gerçek hacmine göre yeniden hesaplanır).
- CPU/RAM DB/worker konkurensleri sınırlandırılır; ses dosyaları bant genişliğine ve disk alanına göre kapasite planı. 1.000 kitap metadata önemsiz, ses ve eşzamanlı yüklemede asıl yük.
- App/DB/worker healthcheck, readiness/liveness, günlük log rotation, disk/RAM/queue/DB connection monitoring; hata uyarısı.
- Dosya varlığını backup ile değil storage adapter semantiğiyle sağlar; tek VPS SLA sağlamaz, uzakta şifreli yedek + kurtarma tatbikatı zorunlu.

## GitHub Actions yürütme kararı (11 Ekim 2026)
Geliştirme için varsayılan yürütme ortamı GitHub-hosted Ubuntu runner'dır. PR `check` hızlıdır; `ci:full`/main/gecelik ve manuel `validation=full` izolasyonlu tam regresyonu çalıştırır. Manuel `validation=fast` yalnız geliştirme geri bildirimi içindir. Actions ortamı production database/asset üzerinde işlem yapmaz. Ayrıntılar `docs/22-GITHUB-ACTIONS-DEVELOPMENT.md`, `docs/60-DEVELOPMENT-CI-ACCELERATION.md` ve `docs/40-DEPENDENCY-RELEASE-GATE.md` içindedir.

## CI platform sozlesmesi (#7, 10 Ekim 2026)
Ubuntu CI `pnpm check`, paylasilan tipler, Drizzle, NestJS, Vite, unit/HTTP, OpenAPI drift, Playwright Chrome, lisans bildirim taramasi ve yerel Docker imaj derlemesini dogrular. Expo `pnpm mobile:export` komutu web JS + Android Hermes + iOS Hermes JS bundle ciktilarini birlikte uretir; `tools/ci/check-expo-exports.mjs` uc hedefi zorunlu kilar. Bu derlemeler native APK/AAB/IPA veya gercek Android/iOS cihaz testi DEGILDIR; bunlar V1-04 kabul kapisinda ayrica uygulanir. Gelistirme audit uyarilari `docs/09-DEPENDENCY-RISKS.md` icinde kayitli; yayin CI icin guvenlik denetimi ayrica zorunlu bloklayicidir. Bu karar prod dagitimi yetkilendirmez.

## Runtime NestJS modularization (#9)
Tek `AppModule` artik yalnizca `SystemModule` baglar ve `common/http.ts` request-id, hata ve ownership sinirlarini uygular. Yeni is bolumleri, auth ve hak denetimleri hazir olduktan sonra ilgili NestJS modulunde kaydedilir; ayrı API/mikroservis kurulmaz. Kabul ve HTTP negatif test kanitlari `docs/11-API-IMPLEMENTATION.md` icindedir.

## Job and migration acceptance baseline (#10)
The Postgres-backed `folioQueues` policy, separate dead-letter queues, and completion receipts are documented in `docs/19-DURABLE-JOBS.md`. Only transaction-scoped DB effects receive durable replay protection. V1 feature-specific handlers must use the provided transaction for their persistent effects and separately protect any file I/O. Queue provisioning can be repeated after restart; no AI/provider queues are enabled. A separate `folio_test` DB and ephemeral GitHub Actions Folio Postgres integration job provide safe failure/timeout/rollback evidence.

## V1-00 NestJS foundation acceptance scope (#9)

The API foundation is a **single NestJS `AppModule`**, composed from active domain Nest modules `SystemModule`, `AccountOnboardingModule`, `WebAuthModule`, `AdminTotpModule` and `AdminCatalogModule`. `RequestIdMiddleware` issues trusted UUIDs, `ApiExceptionFilter` normalizes safe errors, `createOpenApiDocument()` exposes one exact checked-in `/v1` OpenAPI surface. `@folio/contracts` is shared schema/transport code for Web, Expo and admin; `@folio/db` owns PostgreSQL persistence. No Redis, RabbitMQ, separate Python API, or provider services are active. Typed health/DB readiness and bounded capability pagination are public; account/device operations are owner/session-verified, and admin/MFA/catalog operations require explicit direct application TLS opt-in plus DB-backed guards. Unimplemented public book/reader/social APIs do **not** appear as successful routes.

`apps/server/src/architecture-acceptance.spec.ts` exercises **live AppModule** on a loopback socket, validates Swagger bearer/cookie schemes, versioning/owner/admin routes, default-off private responses and server-generated error-trace correlation, and rejects leaked users, public catalog, future and test-only routes. Together with actual Folio-only PostgreSQL/HTTPS integration suites and the `openapi:check` CI drift gate, this defines the #9 architectural acceptance evidence. Completion of future *domain* endpoints and native device UX remains under separate V1 issues. A green architecture test cannot waive #7's independent failed production dependency release gate.
