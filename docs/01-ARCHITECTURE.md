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
- lab (Ubuntu test makinesi): Docker Compose, staging DB ayrı credentials/db, sentetik/dummy veriler, test kullanıcıları, cihaz/browser E2E. 'mehmet' adı yalnız yetkili Desktop Commander erişimi için kullanılacak; adres/token/repo secret yayımlanmaz.
- production: ayrı gerçek sunucu, ayrı secrets, ayrı storage ve DB, HTTPS ve offsite backup. Kullanıcı açık onayı olmadan deployment yok.
- Test cihazı 7/24 açık olsa dahi prod ve lab ayrımı. Production'a taşırken clean deploy + migration + restore test gerekir.

## Kaynak ihtiyacı / kapasite
- Başlangıç tahmini: 8 vCPU, 16 GB RAM, büyütülebilir 250 GB NVMe (metin ve hazır seslerin gerçek hacmine göre yeniden hesaplanır).
- CPU/RAM DB/worker konkurensleri sınırlandırılır; ses dosyaları bant genişliğine ve disk alanına göre kapasite planı. 1.000 kitap metadata önemsiz, ses ve eşzamanlı yüklemede asıl yük.
- App/DB/worker healthcheck, readiness/liveness, günlük log rotation, disk/RAM/queue/DB connection monitoring; hata uyarısı.
- Dosya varlığını backup ile değil storage adapter semantiğiyle sağlar; tek VPS SLA sağlamaz, uzakta şifreli yedek + kurtarma tatbikatı zorunlu.

## CI platform sozlesmesi (#7, 10 Ekim 2026)
Ubuntu CI `pnpm check`, paylasilan tipler, Drizzle, NestJS, Vite, unit/HTTP, OpenAPI drift, Playwright Chrome, lisans bildirim taramasi ve yerel Docker imaj derlemesini dogrular. Expo `pnpm mobile:export` komutu web JS + Android Hermes + iOS Hermes JS bundle ciktilarini birlikte uretir; `tools/ci/check-expo-exports.mjs` uc hedefi zorunlu kilar. Bu derlemeler native APK/AAB/IPA veya gercek Android/iOS cihaz testi DEGILDIR; bunlar V1-04 kabul kapisinda ayrica uygulanir. Gelistirme audit uyarilari `docs/09-DEPENDENCY-RISKS.md` icinde kayitli; yayin CI icin guvenlik denetimi ayrica zorunlu bloklayicidir. Bu karar prod dagitimi yetkilendirmez.
