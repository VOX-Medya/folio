# #12: gerçek tarayıcı → NestJS HTTPS → PostgreSQL katalog E2E

## Ne farklı?

Önceden aynı katalog için iki ayrı test vardı: tarayıcıda `page.route().fulfill()` ile yapay API yanıtları ve sunucu tarafında doğrudan PostgreSQL/HTTPS smoke. Birincisi gerçek yetki veya veritabanı davranışını ölçmez; ikincisi gerçek bir kullanıcı arayüzünü çalıştırmaz. Bu test **aynı süreçte çalışan ikisini bağlar**.

`infra/lab.sh admin-catalog-https-smoke`, yalnız `127.0.0.1:55432/folio_test` veritabanını kabul eder. PostgreSQL migrasyonları CI'da önceden uygulanır. Smoke, mevcut NestJS `AppModule`'ü geçici kendinden imzalı **doğrudan TLS** soketinde başlatır. Gerçek DB'de benzersiz UUID'li synthetic yazar/eser/baskı, gerçek oturumlar, PostgreSQL'de `editor`/`read-only` rolleri ve yalnız sentetik oturumlara bağlı MFA kanıtı oluşturur. Bu test yardımcıları uygulama API'sinde mevcut değildir.

İkinci geçici HTTPS soketi aynı-origin test ağ geçididir. `/v1/*` isteklerini gerçek TLS NestJS sunucusuna, SPA dosyalarını gerçek Vite geliştirme sunucusuna aktarır. Gelen `X-Forwarded-*` başlıkları backend TLS veya kimlik kanıtı yerine **hiç kullanılmaz**. Backend'in gerçek soketi de TLS şifrelidir. `FOLIO_WEB_AUTH_ORIGIN` yalnız tarayıcı testi sırasında bu geçici HTTPS origin'e eşitlenir ve hemen geri yüklenir.

`playwright.live.config.ts`, Chrome'u normal Playwright arayüzüyle 390px genişlikte çalıştırır. `e2e/admin-catalog-live.spec.ts` **hiçbir `page.route` / mock / `fulfill` kullanmaz**. Synthetic gerçek `__Host-folio_session` (Secure, HttpOnly, SameSite=Strict) çerezi yalnız tarayıcı context'ine verilmiştir; sayfa JavaScript'i bearer/token değerini görmez. Browser, mevcut API'den **gerçek HMAC CSRF bootstrap** alır. Farklı editor context'i, ikinci geçerli MFA oturumu üzerinden gerçek HTTPS PATCH göndererek orijinal tarayıcıda `expectedVersion` çakışması oluşturur. İstemci 409'u otomatik tekrar göndermez. Kullanıcı açıkça reload edip devam eder.

Tam akış: gerçek arama → gerçek detay/ilişkiler → ikinci editörün commit'i → istemcinin 409'u → explicit refresh → sürümlü eser düzenleme → opsiyonel başlık düzenleme → yazar rol/sıra düzenleme → iki tıklamalı boş taslak baskı silme → gerçek API GET → PostgreSQL eser sürümü, hak/başlık korunumu, baskı silinmesi ve iki editör kimliğine bağlanan **tam beş işlem audit olayı** kontrolü. Ayrı read-only oturumu yazmaya kalkarsa 403; oturumsuz 401. İstemcide TR/EN, 390px yatay taşma ve HttpOnly izolasyonu doğrulanır.

## Çalıştırma / sınırlar

CI'nin `full-regression` job'unda izole Folio PostgreSQL test veritabanı hazırlanır, ardından `bash infra/lab.sh admin-catalog-https-smoke` komutu canlı tarayıcı alt testini **bekleyerek** çalıştırır. Bu alt test, `pnpm exec playwright test --config playwright.live.config.ts` ile yalnız bu dosyayı çalıştırır. Standart `pnpm e2e` (mock UI regresyonları, Expo Web) bilinçli olarak bu dosyayı `testIgnore` ile dışarıda tutar; aksi halde gerçek DB yokken sahte başarı veya başarısızlık oluşurdu.

Geliştirme PR'ında DB/auth/privacy veya katalog şeması değişiyorsa `ci:full` etiketi merge öncesi kullanılmalı. Değişiklik tüm V1 tasarım/device/kitap içe alma kabulünü bitirmez. iOS simülatör ve fiziksel Android cihaz testleri bu koşuda **yapılmaz**. Tamamlanmamış editoryal belirsiz kaynak/hak eşleme kararları, 320/768/1024+ tasarım/erişilebilirlik ve içerik hakları için ayrı kabul maddeleri devam eder. Canlı deploy veya üretim build yoktur.
