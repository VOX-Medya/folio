# Folio Paperbound tipografik kapak motoru (#17, ilk sözleşme)

`packages/ui-tokens/src/cover.ts` yalnız kanonik eser UUID'si, kitap başlığı, yazarlar, tür, baskı dili (TR/EN), Paperbound şablon sürümü ve light/dark tercihini kullanarak orijinal **SVG string** üretir. Orijinal yayınevi kapağı, dış resim, uzak font veya indirilebilir üçüncü taraf görsel kullanmaz. Aynı giriş, her platformda aynı viewBox ve SVG işaretlemesini üretir; 320×480 viewBox farklı görüntü çözünürlüklerine ölçeklenir.

Türkçe karakterler XML kaçışlama sonrası korunur, ekran okuyucu için tam başlık ve tüm yazarların yer aldığı bir `title` bulunur. Uzun başlıklar deterministik olarak en çok üç satıra yerleştirilir ve gereken satırlarda yatay SVG metin ölçüsü sınırlandırılır. SVG içeriği kullanıcı girdisinden script, görsel referansı veya HTML üretmez. Sürüm `paperbound-v1` olarak sabittir; yeni şablon mevcut kapak çıktısını sessizce değiştiremez.

`packages/ui-tokens/src/cover.spec.ts` tekrar üretim, TR diakritik/uzun başlık, zararlı karakter escaping, TR/EN ve açık/koyu Paperbound renkleri, UUID/boş yazar reddini sınar. Bu testler GitHub Actions `CI` içindeki `pnpm check` tarafından çalıştırılır.

**Henüz tamamlanmayanlar:** gerçek kitap ve admin eser çalışma alanı, render sonrası dosya SHA ve kalıcı özel depolama entegrasyonu (#26), yetkili endpoint, kapak önizleme/yeniden render butonları, tarayıcı çapraz görsel screenshot/snapshot ve thumbnail kontrast E2E. Sadece SVG üreticisinin varlığı #17 görevini completed yapmaz. İçerik revizyonu ve okuma imleci değiştirilmez; hak onayı veya public katalog görünürlüğü açılmaz.
