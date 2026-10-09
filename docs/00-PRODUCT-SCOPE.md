# Folio V1: kapsam sözleşmesi

**Durum:** bağlayıcı plan; kod yazmaya başlamadan önce tüm issue'lar bu belgeyle karşılaştırılır. **Başlangıç hedefi:** 500 özgün Türkçe + 500 özgün İngilizce eser; her birinin diğer dile çevirisi ayrı sürüm; hazır olanlar iki dilde seslendirme. 1.000 kitap / 2.000 dil sürümü hedeftir, lisans veya kalite engeli varken hedefi doldurmak için bozuk eser yayımlanmaz.

## Ürün ilkeleri
1. Kullanıcı uygulaması tek Expo/React Native kod tabanından iOS + Android + responsive Web (masaüstü/tablet/mobil tarayıcı) çalışır. Yönetim paneli ayrı web uygulamasıdır; tümü tek backend kullanır.
2. Backend tüm hesapları, cihaz oturumlarını, kütüphane durumunu, ilerleme imleçlerini, ayarları, kullanıcı onboarding durumunu, işlem durumunu, okuma oturumlarını, notları, hedefleri, istatistikleri, arkadaşlıkları, yorumları ve moderasyonu saklar. İstemcide yalnızca çevrimdışı önbellek/işlem kuyruğu bulunur.
3. Üç okuma biçimi: tipografik e-kitap okuyucu, RSVP hızlı okuma (WPM + kelime grubu), önceden yüklenmiş sesli kitap oynatıcı (hız, bölüm seçimi, arka plan, zamanlayıcı). E-kitap/RSVP/TTS bir mantıksal pasaj konumunu paylaşır; fiziksel sayfa numarası ana ilerleme anahtarı değildir.
4. Kitapların kaynağı ve hukuki durumu birinci sınıf veri. Bir eserin birden çok yazarı, dil sürümü, baskısı, çevirmeni, içerik revizyonu ve farklı ses versiyonları olabilir.
5. Ana eser araması ve yazar araması **vardır**, kullanıcı/arkadaş araması, dizini, kullanıcı önerisi ve telefon rehberi keşfi **yoktur**. Arkadaşlık yalnızca üretilmiş davet kodu / QR / deep link ile, karşılıklı onayla; kullanıcı engelleme, istek iptali ve gizlilik ayarları.
6. Profil görünürlüğü seçilebilir. Kitap rafları, aktif okunan eser, ilerleme, WPM, istatistik, arkadaş listesi ve sosyal aktiviteler ayrı görünürlük kurallarına tabi; varsayılan hassas seçimler korumacı. Özel kullanıcı dosyası ve içeriği hiçbir koşulda başka kullanıcıya otomatik dağıtılmaz.
7. Kitaplar **yeniden yazılmaz**: OCR yok, eksik metni AI tamamlama yok, bozuk sözcük üretken düzeltme yok, otomatik özet/sadeleştirme yok. Metni güvenilir biçimde çıkarılamayan, image-only veya DRM nedeniyle kapalı EPUB/PDF kabul edilmez; kullanıcı anlamlı hata alır.
8. Dipnot, sayfa numarası, yayınevi künyesi, giriş/önsöz, başlık, şiir vb. semantik bloklara ayrılır. RSVP ve TTS akışından yardımcı içerik uygun kurallarla çıkarılır, kaynaktan silinmez; okuma kalitesi bozuksa içerik reddedilir veya incelemeye geçer.
9. Kapak görselleri orijinal yayınevi kapağı kullanılmadan tek Folio tipografik sistemiyle deterministik üretilir. Uzun başlık, karakter desteği ve iki dil test edilir.
10. Global marka: ilk günden Türkçe ve İngilizce UI. UI dili, eser dili, ses dili bağımsız. Ülkelerin telif, kişisel veri ve dağıtım gereklilikleri kontrol edilmeden tüm ülkelerde içerik açılmaz.

## İlk geliştirme (scope:v1)
- Tek depo/tek VPS/tek Docker Compose: NestJS modüler monolit, Postgres+Drizzle, pg-boss iş kuyruğu, dosyalar için yerel özel depolama soyutlaması; gerektiği kadar worker işlemi. Redis/Kubernetes/Elasticsearch zorunlu değil.
- React + Vite + Tailwind admin; kullanıcı arayüzü Expo Router/React Native Web.
- Admin'de 30 ekran haritası; V1 kullanılacak alanlar tamamen işlevsel, ertelenenler açık biçimde devre dışı/gelecek olarak gösterilir. Mock veriler gerçekmiş gibi gösterilmez.
- Kitap, yazar, baskı/dil, metin revizyonu, paragraf, çeviri revizyonu, hazır ses varyant/segmenti, kapak, kaynak kanıtı ve hak incelemesi; CRUD ve audit/versiyon geçmişi.
- Yerelde hazırlanmış kitap, çeviri, hazır ses; manifest + checksum + hak kanıtı içeren sürümlü paketle SSH/CLI veya admin'den batch import. CLI dry-run, apply, rapor, resume, export. 1.000 kitabı tek arşiv zorunluluğu yok: 25-50 eser/parti önerilir.
- Auth ve kullanıcı işlemleri, okuma, ses, RSVP, arama, kişisel yükleme, indirme, çevrimdışı durum, ilerleme/oturum takibi, sosyal aktiviteler, yorumlar, bildirimler (ürün içi) ve moderasyon.
- Ölçümleme: ürünün teknik açıdan gerekli kullanım olayları ve toplulaştırılmış raporlar; kullanıcıya veri kontrolü, analitik rızası/şeffaflığı.
- Lab: mevcut yetkili Ubuntu cihazı üzerinde test ve staging. Canlı yayın ayrı, açık QA/güvenlik/backup gate'inden sonra.

## V1 sonrası kesinlikle ayrı
- Gutenberg / Wikisource / Standard Ebooks / yeni kaynaklar için otomatik discovery/sync/adapter implementasyonu; API scraping.
- İşlenen kitabı otomatik temizleyen generatif/AI sistemler, Jev/Laya sınıflandırma, otomatik çeviri (Qwen/API), otomatik seslendirme (Chatterbox/API), GPU worker iş dağıtımı, bulut fallback, sağlayıcı maliyet panelleri.
- Mesajlaşma, kulüpler, kullanıcıların kitap yayımlaması, premium ödeme/abonelik/billing, gelişmiş yapay zekâ önerileri. Prototip ekranları bu özellikleri V1'e taşımaz.
- V1 yalnızca bu ileri işler için kalıcı model bağları, provider/storage arayüzü tasarımı ve belge/issue hazırlar. **Provider registry ayar menüsünü işlevsel kurmak bile V1 kabul kriteri değildir.**

## Sürüm kapsamı değiştirme prosedürü
- V1 issue'su açılırken scope:v1 ve faz etiketleri; future issue'su yalnızca scope:future ve milestone AFTER-V1 alır.
- Scope değişikliği ayrı karar issue'sunda motivasyon, maliyet, veri migration etkisi ve UI etkisiyle belgelenip onaylanmalı.
- Prototiplerdeki demo içerikler ve izinli gerçek katalog birbirinden ayrıdır; örnek 1984 veya Little Prince gibi kitap isimleri otomatik lisans onayı değildir.
- Ülke bazlı lisans ve çeviri/TTS işleme izni (display, derivative, audio, sharing) yayın kapısıdır.
- "Hazır çeviri" ve "hazır ses" yükleme V1'dir; "çeviri üretimi/ses üretimi" V1 değildir.
