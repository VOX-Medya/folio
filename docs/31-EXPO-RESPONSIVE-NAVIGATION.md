# #29 Expo Router responsive uygulama kabuğu (kısmi)

Folio tek Expo/React Native/React Native Web kod tabanıyla iOS, Android, Web çalışır. `app/_layout.tsx` altında korunan `MobileShellProvider`, Expo Router kullanır. V1 gerçek route ve statik semantik bölümleri:
`/` ana sayfa, `/library` özel kütüphane, `/catalog` eser-yazar araması, `/goals` hedefler ve `/profile` hesap. Bunun dışında kullanıcı araması, arkadaş önerisi, AI çeviri/TTS üretimi veya AFTER-V1 sayfası oluşturulmaz.

Telefon (0–599 px): güvenli alan içinde minimum 48px hedefli alt gezinme, tek sütun; 600–1023px tablet: üst gezinme ve iki sütunlu çalışma alanı; >=1024px masaüstü: 250px sol menü, çok sütunlu çalışma alanı. 320/390/768/1024/1440/1920 px Chrome testleri ekranın yatay taşmamasını, her V1 route'un gerçek URL ile çalışmasını, TR/EN dil seçiminin route ve geçmiş boyunca korunmasını doğrular. Paperbound açık/koyu semantik tokenları ve erişilebilir metinler kullanılır.

**Gerçek kullanıcı/veri durumları:** Oturum doğrulaması henüz devreye alınmadığından, kitap başlığı/istatistik/raf/hesap için örnek veri veya başarılı arama uydurulmaz. Ana sayfada eski "Okuyucu henüz geliştirme aşamasında." açıklaması korunur. Kitap/yazar araması, hak filtreleme tamamlanıncaya kadar etkin değil. Kişisel kitaplar diğer kullanıcılara gösterilmez. Kullanıcı bilgileri backend'de, burada yalnız statik hazır olmayan durumlar gösterilir.

**Tam #29 kabulüne kalanlar:** 58 mobil ekranın V1/future matrisi, gerçek normal/RSVP/sesli okuyucu, authentication/offline cache/progress, telefon-tablet-desktop yerleşim için ayrıntılı tasarım görsel QA, klavye/a11y ekran okuyucu, Android cihaz/Emulator native ve Mac üzerinde iOS-native testleri. Testler yalnız GitHub-hosted Ubuntu Expo Web, Android/iOS JS export ve Chrome E2E; native iOS simülatörlü kanıt yok. Release/production yapılmadı, #29 tamamlandı sayılmaz.
