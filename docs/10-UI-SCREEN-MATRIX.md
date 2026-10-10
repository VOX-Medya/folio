# Folio V1 ekran ve durum matrisi (#8)

> Bu tablo çalışan ekran listesi değil, HTML prototiplerinden türetilmiş tasarım sözleşmesidir. Gerçek API/arayüz testleri her geliştirme issue'sunda ayrıca gerekir.

## Bağlayıcı varsayılan

- Tema: **Paperbound / Parşömen**, `packages/ui-tokens` içinde semantik mobil/admin açık-koyu tokenları. Alternatif referans konseptleri etkin V1 tema motoru değildir.
- UI: DM Sans (fallback system), başlık: Fraunces (fallback Georgia), okuyucu: Georgia. Harici font dosyaları ve lisansları yayımlanmadan önce ayrıca kontrol edilir.
- Telefon: 0-599 px, tablet: 600-1023 px, desktop: 1024+ px. İnceleme genişlikleri **320/390/768/1024/1440/1920 px**; en az 44pt dokunma hedefi.
- Dark mode, TR/EN, klavye ve odak, erişilebilirlik, dinamik font, loading/empty/error/offline/permission/success görünümleri semantik tokenlarla uygulanacaktır.
- `muted` referans renginin küçük metinde kontrastı sınırlı olabilir: `accessibleMuted` kritik etiketlerde kullanılmalıdır; kontrast regresyon testi eklidir.
- Eylem politikaları canlı API entegrasyonu anlamına gelmez. `AFTER-V1` satırları V1 navigasyonundan ve endpointlerinden çıkarılır.

## Mobil: 58 referans / 52 V1 / 6 V1 sonrası

| Grup | Referans ID | Ekran | Kapsam | Ana eylem politikası | Gereken durumlar | Responsive yerleşim |
|---|---|---|---|---|---|---|
| Başlangıç ve üyelik | `splash` | Açılış ekranı | V1 | Uygulama açılış durumu ve dil tercihini yükle | loading, empty, error, offline, permission | Phone: dikey/merkez; tablet: sınırlı genişlik; desktop: sınırlı genişlik |
| Başlangıç ve üyelik | `welcome` | Karşılama | V1 | Giriş veya kayıt akışını seç | loading, validation, success, conflict, error, offline, permission | Phone: dikey/merkez; tablet: sınırlı genişlik; desktop: sınırlı genişlik |
| Başlangıç ve üyelik | `login` | Giriş yap | V1 | Güvenli oturum aç | loading, validation, success, conflict, error, offline, permission | Phone: dikey/merkez; tablet: sınırlı genişlik; desktop: sınırlı genişlik |
| Başlangıç ve üyelik | `signup` | Kayıt ol | V1 | Kullanıcı hesabı oluştur | loading, validation, success, conflict, error, offline, permission | Phone: dikey/merkez; tablet: sınırlı genişlik; desktop: sınırlı genişlik |
| Başlangıç ve üyelik | `onboarding` | Tanıtım akışı | V1 | Kaldığı yerden onboarding durumunu kaydet | loading, validation, success, conflict, error, offline, permission | Phone: dikey/merkez; tablet: sınırlı genişlik; desktop: sınırlı genişlik |
| Başlangıç ve üyelik | `interests` | İlgi alanları | V1 | Okuma ilgi alanlarını kaydet | loading, validation, success, conflict, error, offline, permission | Phone: dikey/merkez; tablet: sınırlı genişlik; desktop: sınırlı genişlik |
| Ana sayfa ve kütüphane | `home` | Ana sayfa | V1 | Son kitap konumuna güvenli şekilde dön | loading, empty, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `library` | Kütüphanem | V1 | Kullanıcının raflarını ve kişisel kitaplarını getir | loading, empty, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `collections` | Koleksiyonlar | V1 | Koleksiyon ekle veya yönet | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `collection-detail` | Koleksiyon detayı | V1 | Koleksiyon içeriğini düzenle | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `book-detail` | Kitap detayı | V1 | Hak kontrolünden geçen eseri kütüphaneye ekle | loading, validation, success, conflict, error, offline, permission, withdrawn | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `editions` | Baskı / çeviri seçimi | V1 | Baskı ve hazır çeviri seç | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `upload` | Kitap yükle | V1 | EPUB veya metin PDF dosyasını özel alana yükle | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `match` | Eser eşleştirme | V1 | Eser eşleştirme sonucunu doğrula | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `analysis` | Kitap işleme | V1 | Dosya doğrulama/ayrıştırma durumunu getir | loading, empty, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `queue` | Seslendirme kuyruğu | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Ana sayfa ve kütüphane | `downloads` | İndirilen kitaplar | V1 | Çevrimdışı özel içerik indirmelerini yönet | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun |
| Okuma ve dinleme | `reader` | E-kitap okuyucu | V1 | Semantik blok okuyucusu ve imleci kaydet | loading, validation, success, conflict, error, offline, permission, withdrawn | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `reader-settings` | Okuyucu ayarları | V1 | Okuyucu tipografi ayarlarını kaydet | loading, validation, success, conflict, error, offline, permission | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `quick` | Hızlı okuma (RSVP) | V1 | RSVP hız, grup ve duraklat kontrollerini kullan | loading, validation, success, conflict, error, offline, permission | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `audio` | Sesli kitap oynatıcı | V1 | Yalnız hazır ses varlığını oynat ve konum kaydet | loading, validation, success, conflict, error, offline, permission, withdrawn | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `voice-select` | Ses seçimi | V1 | Mevcut ses varyantlarından seç | loading, validation, success, conflict, error, offline, permission | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `chapters` | İçindekiler | V1 | Bölüm konumuna git | loading, validation, success, conflict, error, offline, permission | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `highlights` | Altı çizilenler | V1 | Paragrafa sabitli alt çizim ekle | loading, validation, success, conflict, error, offline, permission | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `notes` | Notlar | V1 | Kişisel not ekle veya düzenle | loading, validation, success, conflict, error, offline, permission | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `book-search` | Kitap içi arama | V1 | Yalnız kitap içindeki metni ara | loading, empty, error, offline, permission | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Okuma ve dinleme | `reading-history` | Okuma geçmişi | V1 | Kullanıcının izinli okuma oturumlarını göster | loading, empty, error, offline, permission | Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel |
| Keşfet ve katalog | `discover` | Keşfet | V1 | Editör seçimlerini ve hakları onaylı eserleri getir | loading, empty, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Keşfet ve katalog | `catalog-search` | Eser / yazar ara | V1 | Yalnızca eser ve yazar araması yap | loading, empty, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Keşfet ve katalog | `search-results` | Arama sonuçları | V1 | Eser/yazar arama sonuçlarını listele | loading, empty, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Keşfet ve katalog | `author-page` | Yazar profili | V1 | Yazarın hakları izinli eserlerini göster | loading, empty, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Keşfet ve katalog | `public-library` | Ortak kütüphane | V1 | Yayımlama hakkı doğrulanmış katalogu getir | loading, empty, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Keşfet ve katalog | `recommendations` | Kitap önerileri | V1 | Yalnız editöryal önerileri göster | loading, empty, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Keşfet ve katalog | `reading-list` | Okuma listem | V1 | Okumak istediklerim rafını güncelle | loading, validation, success, conflict, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Keşfet ve katalog | `reviews` | Kitap incelemeleri | V1 | Kitap yorumlarını moderasyonla görüntüle | loading, empty, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Keşfet ve katalog | `review-compose` | İnceleme yaz | V1 | Hak denetimli kitap incelemesi gönder | loading, validation, success, conflict, error, offline, permission | Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun |
| Arkadaşlar ve topluluk | `social` | Sosyal akış | V1 | Gizlilik filtresinden geçen arkadaş etkinliklerini gör | loading, empty, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `friends` | Arkadaşlarım | V1 | Yalnız onaylı arkadaşlıkları listele | loading, empty, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `friend-invite` | Arkadaş ekle | V1 | Süreli ve sınırlı davet kodu oluştur | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `friend-qr` | QR davet kodu | V1 | Davet kodunun QR gösterimini aç | loading, empty, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `friend-code` | Arkadaşlık kodu gir | V1 | Davet kodunu doğrula ve arkadaşlık iste | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `friend-requests` | Arkadaşlık istekleri | V1 | Arkadaşlık isteğini kabul et veya reddet | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `friend-profile` | Arkadaş profili | V1 | Gizlilik matrisinden geçen profili görüntüle | loading, empty, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `activity` | Okuma etkinlikleri | V1 | İzinli okuma etkinliklerini listele | loading, empty, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `comments` | Yorumlar | V1 | Moderasyona tabi kitap etkinliği yorumu gönder | loading, validation, success, conflict, error, offline, permission | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `clubs` | Kitap kulüpleri | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Arkadaşlar ve topluluk | `messages` | Mesajlar | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli |
| Profil ve ayarlar | `profile` | Profilim | V1 | Kendi profilini ve izinli alanlarını görüntüle | loading, empty, error, offline, permission | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `edit-profile` | Profili düzenle | V1 | Profil alanlarını doğrulayarak kaydet | loading, validation, success, conflict, error, offline, permission | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `privacy` | Gizlilik | V1 | Profil ve raf görünürlük seçeneklerini kaydet | loading, validation, success, conflict, error, offline, permission | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `stats` | Okuma istatistikleri | V1 | Kullanıcının okuma istatistiklerini göster | loading, empty, error, offline, permission | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `goals` | Okuma hedefleri | V1 | Okuma hedeflerini ve durumu güncelle | loading, validation, success, conflict, error, offline, permission | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `notifications` | Bildirimler | V1 | Uygulama içi bildirimleri oku/işaretle | loading, validation, success, conflict, error, offline, permission | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `settings` | Ayarlar | V1 | Cihaz ve kullanıcı tercihlerini yönet | loading, validation, success, conflict, error, offline, permission | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `language` | Uygulama dili | V1 | Arayüz dilini Türkçe/İngilizce değiştir | loading, validation, success, conflict, error, offline, permission | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `premium` | Premium üyelik | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `publishing` | Yazar stüdyosu | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |
| Profil ve ayarlar | `publish-book` | Kitap yayımla | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı |

## Admin: 30 referans / 22 V1 / 8 V1 sonrası

| Grup | Referans ID | Ekran | Kapsam | Ana eylem politikası | Gereken durumlar | Responsive yerleşim |
|---|---|---|---|---|---|---|
| Genel bakış | `dashboard` | Kontrol merkezi | V1 | Yetkili içerik ve işlem özetini görüntüle | loading, empty, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Genel bakış | `analytics` | İşlem ve kullanım raporları | V1 | Gerçek işlem ve kullanım istatistiklerini getir | loading, empty, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `works` | Tüm eserler | V1 | Eserleri listele/filtrele; yetkili CRUD uygula | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `detail` | Eser çalışma alanı | V1 | Yedi sekmeli eser kayıtlarını yetkili biçimde yönet | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `authors` | Yazarlar | V1 | Yazar ve katkıda bulunanları düzenle | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `editions` | Baskılar ve diller | V1 | Eser baskılarını ve dillerini düzenle | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `versions` | Metin sürümleri | V1 | Değişmez kaynak için yeni içerik revizyonu oluştur | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `translations` | Çeviri yönetimi | V1 | Hazır çeviriyi içe aktar, revizyonla ilişkilendir | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `audios` | Ses kütüphanesi | V1 | Hazır ses varlıklarını yükle, doğrula ve değiştir | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `covers` | Kapak şablonları | V1 | Standart tipografik kapak ayarlarını yönet | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Merkezi katalog | `rights` | Lisans ve telif | V1 | Hak kanıtı, bölge ve izinleri denetle | loading, validation, success, conflict, error, offline, permission, withdrawn | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Kaynaklar ve işleme | `sources` | Kaynak entegrasyonları | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Kaynaklar ve işleme | `mapping` | Kaynak alan eşlemesi | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Kaynaklar ve işleme | `staging` | Gelen kayıtlar | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Kaynaklar ve işleme | `pipeline` | İşleme kuralları | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Kaynaklar ve işleme | `quality` | Kalite inceleme | V1 | Metin yapısı QA ve manuel onay iş akışı | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Kaynaklar ve işleme | `jobs` | Tüm işlem işleri | V1 | Yalnız yerel import/validasyon işlerini görüntüle | loading, empty, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| AI ve üretim | `translationQueue` | Çeviri kuyruğu | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| AI ve üretim | `ttsQueue` | Seslendirme kuyruğu | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| AI ve üretim | `workers` | Yerel & bulut workerlar | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| AI ve üretim | `providers` | Servis sağlayıcıları | AFTER-V1 | Pasif: V1 navigasyonu ve API bağlantısı yok | disabled | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| AI ve üretim | `storage` | Dosyalar ve depolama | V1 | Özel dosya, alan ve kota özetlerini görüntüle | loading, empty, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Veri taşınabilirliği | `transfer` | Import / Export | V1 | Batch import/export kuru çalışma ve uygulama | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Veri taşınabilirliği | `backups` | Yedek ve geri yükleme | V1 | Yedekleme ve geri yükleme test raporlarını göster | loading, empty, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Topluluk | `members` | Üyeler | V1 | Yetkili kullanıcı destek işlemlerini uygula | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Topluluk | `friendship` | Arkadaşlık ve gizlilik | V1 | Davet, blok ve gizlilik taleplerini incele | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Topluluk | `moderation` | Yorum ve şikâyetler | V1 | Yorum raporu ve moderasyon işlemini kaydet | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Sistem | `settings` | Genel ayarlar | V1 | Genel V1 yapılandırmasını düzenle | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Sistem | `roles` | Roller ve yetkiler | V1 | RBAC yetkilerini denetimli değiştir | loading, validation, success, conflict, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |
| Sistem | `audit` | İşlem günlüğü | V1 | Değişmez işlem denetim günlüğünü incele | loading, empty, error, offline, permission | Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector |

## Uygulama kısıtları

- Kitap ve yazar araması izinlidir; kullanıcı arama, kullanıcı keşfi ve arkadaş önerisi yoktur.
- Offline istemci yalnızca cache ve bekleyen işlem tutar; kalıcı durum tek backend'dedir.
- Kişisel kitaplar diğer hesaplara açılmaz. Ortak eserler telif ve ülke hakkı onayından geçer.
- Ses ve çeviri varlıkları hazır olarak yüklenir. AI üretimi, TTS üretimi, otomatik kaynak senkronu ve üretim iş kuyrukları V1'de yoktur.
- Gelecek route'ları görünür ürün işleviymiş gibi render edilmez. Bu matris demo içeriklerini ürün verisi saymaz.

