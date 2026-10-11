# #36 MVP | Sunucuda kalıcı okuma konumu

## Uygulanan kesit

- Tek user_reading_positions kaydı: doğrulanmış kullanıcı + immutable revizyon anahtarı, gerçek bölüm/blok UUID, kelime ofseti, mod, ses milisaniyesi ve monoton sürüm.
- GET /v1/me/progress/{revisionId} yalnız kendi kaydını veya {progress:null} döndürür. PUT aynı yola expectedVersion ile yazar. İlk versiyon sıfır, sonraki yazmalar sunucunun son versiyonuyla karşılaştırılır. Eski sürüm 409 ve mutasyonsuz ret alır.
- Yayımlanmış eser, baskı, revizyon, güncel ülke bazlı üç aşamalı hak onayı, kaynak SHA ve katalog varlığı doğrulanmadan hiçbir özel konum okunmaz/yazılmaz. Yayından kaldırma konumu saklar fakat erişimi 404 olur.
- Kullanıcı ID veya territory istemciden gelmez. Güncel hesap/cihaz oturumu PostgreSQL'de doğrulanır. Tarayıcı yalnız gerçek HTTPS same-origin HttpOnly cookie + CSRF ile yazar.
- Bölüm ve blok güncel yayımlanmış metne ait olmak zorundadır; RSVP token sınırları, ses pozisyonu ve revizyon doğrulanır.
- Expo Web: normal okuyucu blok seçimi, RSVP kelime konumu, ses seek/pause konumu ve açık Konumu kaydet eylemi. Yeniden açıldığında kayıtlı bölüm ve mod geri gelir. Anonim okuma sürer, 409 sessizce üzerine yazılmaz.
- Native JS export korunur; cihaz kimlik taşıması ve gerçek native oynatma #30/#48'de ayrıca doğrulanır. Tam offline/heartbeat/çeviri hizalama AFTER-MVP.

## Kabul kanıtı

- packages/db/drizzle/0022_user_reading_positions.sql ve packages/db/src/reading-position.ts
- apps/server/src/modules/account/reading-position.module.ts ve packages/contracts/src/reading-position-client.ts
- e2e/public-shelf-live.spec.ts: Chrome/Expo/HTTPS/izole PostgreSQL üzerinde normal/RSVP/ses, yeniden açma, ikinci hesap ve stale 409.
- Gerçek GitHub Actions ci:full doğrulaması başarılı olmadan issue tamamlanmış sayılmaz.
