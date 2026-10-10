# #26 Kullanıcıya özel dosya kotası: PostgreSQL rezervasyonları

## Gerçekleştirilen parça

`storage_upload_reservations` tablosu, ileri yönlü `0009_private_upload_quota.sql` migration'ı ile eklenir. `owner_user_id`, rezerve bayt sayısı, geçerlilik zamanı, `reserved/committed/released` durumu ve varsa tek `media_assets` hedefi saklanır. Sıfır/negatif rezervasyon yasaklanır; committed asset bire bir benzersizdir. Önceden kaydedilmiş medya dosyaları veya içerik revizyonları değiştirilmez, silinmez, otomatik doğrulanmaz.

`packages/db/src/private-quota.ts` **yalnız güvenilir dahili servis** olarak çalışır:

- `reservePrivateUploadQuota` aynı kullanıcı UUID'si için PostgreSQL transaction/advisory lock tutar; henüz süresi dolmamış tüm `reserved` baytlarını ve `media_assets` içindeki mevcut (quarantine dahil) private-user baytlarını toplar. Toplam, uygulamanın güvenilir tarafta belirlediği kullanıcı kotasını geçerse kaydı/audit'i kabul etmez.
- `commitPrivateQuarantinedUpload` erişim verilen owner ile staged owner'ın bire bir aynı olduğunu ve LocalStorageAdapter dosyasının SHA-256/boyut/inode doğrulamasını yeniden geçtiğini denetler. Tek transaction içinde `pending_verify` medya metadata'sını oluşturur, rezervasyonu `committed` durumuna geçirir ve audit yazar. İşlem tekrarı aynı asset UUID'sini döndürür; başka kullanıcı veya farklı payload ile replay reddedilir.
- `releasePrivateUploadQuota` kullanılmayan rezervasyonu serbest bırakır ve audit kaydı oluşturur. Committed varlık doğrudan quota release ile silinemez; veri kaybını engeller.
- `inspectPrivateUploadQuota` sadece görünürlük içindir, yüklemeyi kabul etmek için kullanılmaz. Süresi dolmuş rezervasyonlar hesaplamaya dahil edilmez.

API, istemci veya oturum doğrulaması **henüz bağlanmadı**. `ownerUserId` yalnız gerçek güvenilir auth principal'ından alınmalı; HTTP'deki istemci header'ı kimlik kanıtı sayılamaz. Yüklenen dosya `pending_verify` kalır. Gerçek malware scanner, ses codec/duration parser, EPUB/PDF semantic parser, kullanıcı veri saklama politikası, büyük upload throttle, orphan cleanup ve yetkili stream olmadan dosya katalogda oynatılabilir/yayımlanmış sayılmaz. GitHub Actions runner dosyaları sentetik geçici dosyalardır; gerçek eser veya kullanıcı kimliği içermez.

## GitHub Actions izolasyon kabul testi

`bash infra/lab.sh storage-quota-smoke` yalnız `127.0.0.1` Folio test PostgreSQL `folio_test` üzerinde çalışır. Test iki **bağımsız DB connection pool** ile aynı 100 baytlık kotaya eşzamanlı 70+70 rezervasyon denemesi yapar; kesinlikle bir başarılı, bir başarısız olmalıdır. Sonra gerçek sentetik UTF-8 byte staging, owner spoofing reddi, tam byte sayısına göre kota muhasebesi, tekrarlanan commit'in aynı UUID'yi döndürmesi, kota dolduğunda reddetme, kullanılmayan rezervasyonu bırakma, committed kayıt release reddi, expired reservation'ın kota tutmaması ve audit/medya metadata bütünlüğünü sınar.

`.github/workflows/ci.yml` bu testi mevcut Folio'ya özel `test-db`, katalog/haklar/içerik/ses/import smoke testlerine ekler. Production deploy, harici domain/obje depolama servisi, kullanıcı veritabanı, diğer Compose volume'leri veya gerçek mobil cihaz testi bu test kapsamına dahil değildir.

## Kalan kritik işler

Auth/RBAC (#30/#43), PDF/EPUB/audio tam medya tarama + fail-closed scanner, private authenticated streaming/Range ve anti-enumeration, quota limitlerinin admin politikasına bağlanması, eşzamanlı upload sayısı sınırı, expired-reservation/orphan garbage collection, local volume crash/retry restore ve rights country/action cache invalidation (#14) bu issue'nun kabul kapısı olmaya devam ediyor. #26 **completed değildir**.


## Media asset DB bütünlüğü / forward-only migration (#26, kısmi)

`0018_private_asset_owner_integrity.sql` var olan içerikleri, kitap revizyonlarını, kaynak bloblarını veya daha önceki medya satırlarını **otomatik değiştirmez**. Doğrulama kanıtı olmayan geçmiş kayıtlar `pending_verify` olarak kalır. Yeni kısıtlar daha önce yazılmış bozuk/yanlış sahiplikli satırlar varsa migration'ı **başarısız** kılar; kayıtları sessizce `verified` yapmaz, silmez veya sahiplendirmez. Düzeltme ancak ayrı, izlenebilir insan incelemesiyle yapılır. Tekrarlanan migrate işlemi idempotent Drizzle journal'ına bağlıdır.

**PostgreSQL tarafından zorunlu kılınan değişmezler:**

- `catalog` satırlarında `owner_user_id` null; `private-user` satırlarında gerçek UUID zorunlu. Başka kapsam reddedilir. Önceden hazırlanmış **katalog manifesti** saklama anahtarı ayrı mantıksal referans olabilir; adaptörün dosya açma yolu **olamaz**. `private-user` kayıtlarının storage key'i yalnız küçük harfli opaque UUID biçimindedir.
- SHA-256 tam 64 küçük harf hex, pozitif byte sayısı ve 1 GiB tavanı, destekli MIME ailesi ve varsa pozitif audio duration veritabanı `CHECK` olarak korunur. Bu **baytların gerçekten tarandığı veya ses codec/duration çözümlemesinin doğrulandığı** anlamına gelmez.
- Bilinen durumlar `pending_verify,verified,rejected,deleted`. `verified_at` alanı eklendi; `verified` olmadan bu alana değer yazılamaz, `verified` satırda timestamp olmadan da yazılamaz. Ancak timestamp **scanner kanıtı yerine geçmez**. Henüz herhangi bir `pending_verify -> verified` servis metodu veya HTTP route açılmamıştır. Reject/deletion sonrası verification tarihi tarihçe olarak saklanabilir.
- `storage_upload_reservations` committed durumda mutlaka `committed_asset_id` taşır; `reserved/released` satırı asla taşımamalı. Rezervasyon boyutu 1 GiB ile sınırlı. Ek `(committed_asset_id,owner_user_id)` composite FK; farklı kullanıcının veya katalogun asset UUID'sine bağlanamaz. Sahip/durum indeksleri DB sorgularını owner-scope sınırında tutar.

GitHub Actions'ta Folio-only `folio_test` PostgreSQL üzerinde `storage-integrity-smoke` uygulaması; 15 sahte/unsafe medya satırının SQL check reddini, yanlış sahip FK, bozuk rezervasyon durumları, eski katalog manifest anahtarının hâlâ sadece `pending_verify` kalmasını, geçerli private-user dosya metadata'sını ve sentetik örneklerin transaction rollback'ini sınar. `local-storage.spec.ts` mode 0600 bozulduğunda veya aynı byte boyundaki dosya değiştiğinde fail-closed denetimi de yapar. **Bunlar backend integrity testleridir, scanner veya medya playback kabulü değildir.**

**Kalan #26 işler:** güvenilir malware scanner + MIME/EPUB/PDF/ses codec-duration semantik doğrulaması, atomik verified blob promote ve fsync/cleanup, eski orphan/expired quota temizlik, gerçek auth/owner+rights+territory denetimli streaming byte Range/TTL revokasyonu, yayın sınırı ve gerçek native/web QA. Bağımsız #7 release dependency audit engeli devam eder; yayın veya production build yoktur.
