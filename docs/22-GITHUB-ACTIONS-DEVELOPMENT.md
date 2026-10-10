# GitHub Actions V1 geliştirme ve test işletimi

## Kapsam

V1 geliştirme kodları GitHub issue referanslı branch/PR üzerinden gönderilir. GitHub-hosted Ubuntu runner'ı, erişimi kotalı olan yerel Desktop Commander \`mehmet\` yerine **CI/test için** kullanılabilir. Bu izin bir production deploy, mağaza submission, VPS bağlantısı veya gerçek kullanıcı verisi aktarımı izni değildir. GitHub Actions kendi başına ürün kodunu yazan veya 7/24 iş yapan bir agent değildir; kod değişiklikleri ayrı PR gerektirir.

\`.github/workflows/ci.yml\` otomatik olarak PR ve \`main\` push'larında, isteğe bağlı olarak GitHub Actions sekmesindeki **CI > Run workflow** üzerinden çalışır. En düşük izin \`contents: read\`; hiçbir production secret, environment veya release token istemez. Aynı branch'te eski CI denemeleri yeni push ile iptal edilir.

## Standart kabul akışı

1. GitHub issue'da en öncelikli, bağımlılığı karşılanmış V1 task'ını seç. Kod ve test değişikliğini bir branch'te PR olarak aç.
2. \`pnpm install --frozen-lockfile\` ile bağımlılıkları yeniden kur; \`pnpm check\` lint, TypeScript, paket testleri, derlemeler, API ve design sözleşmelerini doğrular.
3. Folio'ya özel geçici Compose projesinde PostgreSQL ve ayrı \`folio_test\` DB hazırlanır. Tekrar migration, catalog/content/rights/translation/audio/job/import smoke testleri çalışır. Gerçek/saha veritabanı, başka Compose projesi veya kullanıcı volume'ü erişilebilir değildir.
4. Expo Web, Android Hermes ve iOS Hermes JS export'ları doğrulanır. Bu testler **APK/AAB/IPA, Xcode, simülatör, fiziksel Android/iOS** testi değildir. Playwright Chrome 320–1920 px kontrolleri, lisans bildirim denetimi ve deployment yapmadan Docker image build çalışır.
5. Hata olursa logları ve gerekliyse yalnız başarısız UI test artefaktlarını GitHub Actions'ta incele. Sorunu aynı PR'da düzelt ve kontrolleri baştan geçir. **Yeşil CI tek başına ilgili issue'yu completed yapmaz**; DoD ve hak/erişim/release kabul koşulları ayrıca doğrulanır.
6. Başarılı ve kabul kriterleri karşılanmış PR'ı \`main\` ile birleştir; issue'ya commit, test run, sonuç, engel ve eksik kabul maddelerini kaydet. İnsan/yayın onayını gerekmedikçe ertele.
7. \`main\` için de aynı CI koşar. Kritik bağımlılık audit bulguları geliştirme için geçici bilgilendirme düzeyindedir; gerçek kullanıcıya yayın aşamasında bloklayıcı güvenlik kontrolü zorunludur.

## #26 güvenli private storage başlangıcı

\`packages/db/src/local-storage.ts\` ve \`local-storage.spec.ts\`, gerçek kullanıcı dosyası kullanmadan GitHub-hosted Ubuntu üzerinde test edilen **quarantine-only** yerel dosya adaptörünün başlangıcıdır. İçe alınan stream boyutu ve SHA-256 kontrol edilir; dosya adı yalnız sunucunun ürettiği UUID'dir. Folio'ya özel private root altında scope ve user ID segmentleri ayrılır, izinler 0700/0600, symlink/hardlink ve bozuk dosya reddi test edilir. İşlem sonucunda \`pending_verify\` döner; bu **MIME magic sniff = tam içerik/codec/zararlı yazılım doğrulaması** anlamına gelmez.

**Etkinleştirilmeyenler:** ayrı üretim asset volume, PostgreSQL media_assets lifecycle/quota/reservation migration, codec/duration ve EPUB/PDF derin sanitize, scanner sonucu, kullanıcı doğrulaması/RBAC/hakları, yayın/stream API'si, tam #19 asset import. Bu bileşenler ve gerçek restart/disk-full/iki-kullanıcı HTTP testleri tamamlanmadan #26 kapatılmaz, indirme veya public visibility açılmaz.

## Veri, secret ve ortam güvenliği

GitHub-hosted runner diskindeki veri ephemeral sentetik fixture'dır. \`infra/lab.sh\` CI'da yeni \`infra/.env.lab\` secret üretir, \`.gitignore\` bunu dışlar ve \`bash infra/lab.sh down\` yalnız Folio CI konteynerlerini kapatır (volume silmez). Repo içinde credential, Apple certificate veya telifli gerçek kitap dosyası saklanmaz. CI'daki \`folio_lab\` başka makinedeki \`mehmet\` lab'ının DB'si değildir. Dış ortam/production deploy ve gerçek dosya aktarımı için açık kullanıcı onayı şarttır.

## Takip

Issue ve ilerleme oranları yalnız GitHub'da \`scope:v1\` + \`type:task\` geçerli task'larından; duplicate ve future hariç; bütün DoD'leri karşılayan \`completed\` kapatmalarından hesaplanır. PR merge edilmesi tek başına görev tamamlandığı anlamına gelmez. Kullanıcı tarafında tekrarlanan otomatik kod üretimi veya sonsuz arka plan görevi devreye alınmaz; yeni kod değişiklikleri ayrıca yürütülür ve PR'lar üzerinden denetlenir.
