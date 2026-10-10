# Folio Paperbound tipografik kapak motoru (#17, ilk sözleşme)

`packages/ui-tokens/src/cover.ts` yalnız kanonik eser UUID'si, kitap başlığı, yazarlar, tür, baskı dili (TR/EN), Paperbound şablon sürümü ve light/dark tercihini kullanarak orijinal **SVG string** üretir. Orijinal yayınevi kapağı, dış resim, uzak font veya indirilebilir üçüncü taraf görsel kullanmaz. Aynı giriş, her platformda aynı viewBox ve SVG işaretlemesini üretir; 320×480 viewBox farklı görüntü çözünürlüklerine ölçeklenir.

Türkçe karakterler XML kaçışlama sonrası korunur, ekran okuyucu için tam başlık ve tüm yazarların yer aldığı bir `title` bulunur. Uzun başlıklar deterministik olarak en çok üç satıra yerleştirilir ve gereken satırlarda yatay SVG metin ölçüsü sınırlandırılır. SVG içeriği kullanıcı girdisinden script, görsel referansı veya HTML üretmez. Sürüm `paperbound-v1` olarak sabittir; yeni şablon mevcut kapak çıktısını sessizce değiştiremez.

`packages/ui-tokens/src/cover.spec.ts` tekrar üretim, TR diakritik/uzun başlık, zararlı karakter escaping, TR/EN ve açık/koyu Paperbound renkleri, UUID/boş yazar reddini sınar. Bu testler GitHub Actions `CI` içindeki `pnpm check` tarafından çalıştırılır.

**Henüz tamamlanmayanlar:** gerçek kitap ve admin eser çalışma alanı, render sonrası dosya SHA ve kalıcı özel depolama entegrasyonu (#26), yetkili endpoint, kapak önizleme/yeniden render butonları, tarayıcı çapraz görsel screenshot/snapshot ve thumbnail kontrast E2E. Sadece SVG üreticisinin varlığı #17 görevini completed yapmaz. İçerik revizyonu ve okuma imleci değiştirilmez; hak onayı veya public katalog görünürlüğü açılmaz.


## Paylaşılan native / Web geometri sözleşmesi (#17, kısmi)

`layoutFolioCover` her platforma eşit 320x480 mantıksal koordinat, Paperbound arkaplan/önplan/vurgu, deterministik başlık/yazar satır kırılımları, y koordinatları, font ölçüsü, footer ve **tam erişilebilir etiket** verir. Orijinal SVG üreticisi bu ortak yerleşimden oluşturulur. Yeni `apps/mobile/src/FolioTypographicCover.tsx` aynı koordinatları verilen genişlikten ölçekleyen saf React Native `View/Text` bileşenidir; Android/iOS native modül, WebView, `react-native-svg`, ağ fontu ve yeni bağımlılık yoktur. İstemci görsel öğeleri katalog/hak/güvenilir oturum kontrolü yerine **geçmez**. Gelecekteki kitap kartı/detay ekranı yalnız sunucunun hak ve kullanıcı görünürlük kontrolünden **sonra** bileşeni kullanabilir. Şu anda sahte kitapla bir vitrin veya anonim katalog görünümü açılmamıştır.

Sadece belirtilen `paperbound-v1` ve TR/EN ile güvenilir eser UUID/başlık/yazar/tür kabul edilir. NFC eşdeğer karakterler aynı yerleşimi üretir; yasadışı XML karakteri, tek kalan UTF-16 surrogate ve görünmez yön değiştiren Unicode kontrolleri **reddedilir**, sessizce metin değiştirilmez. Ekler/uzun tür ve fazla yazarların *görsel* satırları sınırlanır, tüm yazarlar screen-reader `accessibleLabel` içinde saklanır. Küçük kapakta erişilebilir ad korunur; esas kitap kartı başlık/yazar metni ayrı ve ölçeklenebilir sunulmalıdır.

`cover.spec.ts` web SVG ile yerel yerleşim parity, NFC/TR diakritik, uzun yazar/tür taşma, XML injection denial, birden fazla Paperbound fonunda WCAG 4.5:1 kontrast ölçümü ve deterministik üretim testlerini çalıştırır. Expo Web/Android/iOS JS export kontrolü native bileşenin hedeflerde bağlanabildiğini doğrulayacaktır. Ancak **tam piksel eşitliği** platformun yerel font motoruna bağlıdır; yalnız geometri eşitliği kanıtlanmıştır.

**Kalan #17 işleri:** Yetkili gerçek eserde admin kapak önizleme ve editoryal kontrol, farklı boyutlarda tarayıcı gerçek görsel snapshot, native Android/iOS gerçek cihaz görsel karşılaştırması, verified SHA-256 dosya varlığı/özel StorageAdapter (#26), asset API için hak-gate (#14), taslak/onay/yayın ayrımı (#23), server worker `folio.cover.render` job handler. Bunlar tamamlanmadan #17 **completed** olarak kapatılmaz.
