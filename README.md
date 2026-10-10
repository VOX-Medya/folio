# Folio

Türkçe ve İngilizce odaklı, iOS / Android / Web üzerinde çalışan dijital kitap, hızlı okuma, sesli kitap ve sosyal okuma platformu.

> **Durum: planlama.** Bu depoda ilk aşamada yalnızca kapsam, mimari, tasarım referansları ve ayrıntılı GitHub Issues oluşturulmaktadır. Prototip HTML dosyaları çalışan ürün değildir.

## V1 sınırı (değişiklik yönetimine tabi)
- Tek monorepo; tek VPS üzerinde Docker Compose, NestJS modüler monolit + PostgreSQL + worker, Expo/React Native Web ve ayrı React web admin.
- 500 Türkçe + 500 İngilizce özgün eser hedefi; TR/EN çeviri sürümleri ve hazır ses dosyaları **yerelde üretilecek**, standart manifest ve checksum paketleriyle import edilecek.
- Katalog: eser → yazar(lar) → baskı/dil → değişmez içerik revizyonu → bloklar → çeviri → bölüm bazında ses dosyaları; tekilleştirme ve hak değerlendirmesi.
- Kullanıcı hesabı, oturum, gizlilik, kişisel EPUB/PDF yükleme, ortak kütüphane, RSVP, sesli kitap, notlar, istatistikler, tam konum/süreç senkronizasyonu, davetle arkadaşlık ve sosyal akış.
- **YASAK:** kullanıcı arama/keşif/arkadaş önerisi; OCR; eksik cümle üretimi veya metni yeniden yazma; izinsiz telifli içerik paylaşımı; kullanıcı kitaplarının diğer hesaplara açılması.
- Yalnızca metni çıkarılabilen ve sırası güvenilir EPUB/PDF dosyaları kabul edilir; uygunsuz dosyalar anlamlı hata mesajıyla reddedilir.
- Tek tip Folio tipografik kapak; yayınevlerinin özgün kapakları katalogta kullanılmaz.

## V1 kapsamında **OLMAYAN** işler
- Otomatik Gutenberg / Wikisource / Standard Ebooks senkronizasyonu; scraper veya otomatik kaynak keşfi.
- Üretim Laya/Jev sınıflandırma entegrasyonu; otomatik bulut/yerel kitap çeviri üretimi; otomatik TTS üretimi; GPU worker leasing.
- Kullanıcılar arası özel mesajlar, kitap kulüpleri, bağımsız yazar yayıncılığı, ücretli abonelik/billing. Referans prototiplerde bu ekranların bulunması V1 işlevi oldukları anlamına gelmez.
- Bunların yalnızca veri modelindeki uzatma noktaları, menüde görünürlük politikaları ve geleceğe dönük, ayrı `future` issue'ları hazırlanır.

## Plan ve tasarım belgeleri
- [Kapsam ve değişmez kararlar](docs/00-PRODUCT-SCOPE.md)
- [Tek sunucu mimarisi](docs/01-ARCHITECTURE.md)
- [Veri modeli ve hak politikası](docs/02-DATA-CONTRACTS.md)
- [Tasarım sistemi ve ekran haritası](docs/03-DESIGN-SPEC.md)
- [Okuma motoru ve ilerleme](docs/04-READER-SYNC.md)
- [Paket import/export sözleşmesi](docs/05-IMPORT-EXPORT.md)
- [Test, güvenlik ve yayın kapıları](docs/06-TEST-RELEASE.md)
- [V1 sonrası kilitli kapsam](docs/07-FUTURE.md)
- [Mobil interaktif referans](design/reference/folio_ui_tasarim_studyosu.html)
- [Admin interaktif referans](design/reference/folio_admin_tasarim_studyosu.html)

## İş yönetimi
GitHub Issues üzerinde `P0` (temel), `P1` (V1 özellik), `P2` (V1 sertleştirme) ve `FUTURE` ayrımı kullanılır. `scope:v1` ve `scope:future` birbirinin yerine geçemez. Her issue; teslimat, kabul kriterleri, test kanıtı, bağımlılıklar ve kapsam dışını içerir.

## Geliştirme ortamı
İlk uygulama ve testler yetkili Ubuntu masaüstü laboratuvarında yapılacak; üretim yayını, güvenlik/yedek geri yükleme ve uçtan uca testlerden sonra ayrıca onaylı olarak yapılacak. Fiziksel cihaz/host sırları veya API anahtarları bu depoda tutulmaz.
## Ubuntu geliştirme ortamı (Issue #7)
- `mehmet` Ubuntu üzerinde Node.js 22.22.1 ve pnpm 10.34.5; sürümler `.nvmrc` ve `package.json` ile sabitlenmiştir.
- İlk kurulum: `pnpm install --frozen-lockfile`. Kontroller: `pnpm check`, `pnpm --filter @folio/mobile exec expo export --platform web`, `pnpm licenses list --json > licenses.json` ve `node tools/security/check-licenses.mjs licenses.json`.
- API: `pnpm --filter @folio/server dev` (localhost:3100, `/v1/health`, `/openapi`). Admin: `pnpm --filter @folio/admin dev`. Expo Web: `pnpm --filter @folio/mobile web`.
- Başlangıç ekranları yalnızca geliştirme kabuğudur. Henüz kitap kataloğu, kimlik doğrulama, veritabanı veya gerçek kullanıcı işlemleri sunmaz.
- Docker Compose/PostgreSQL/pg-boss #10 ve #11 ile izole kurulacaktır; ilgili olmayan konteynerlere, ağlara ve verilere dokunulmaz.
- İlgili bağımlılık riskleri `docs/09-DEPENDENCY-RISKS.md` içinde izlenir; tarama geçmeden #7 kapatılmaz.
- Gerçek Ubuntu Chrome smoke testleri: `pnpm e2e`. Kontrol edilen başlangıç görünümü genişlikleri: 320, 390, 768 ve 1440 px. Bu testler tüm ürün ekranlarının işlevselliği yerine başlangıç kabuğu ve yatay taşma durumunu doğrular.
