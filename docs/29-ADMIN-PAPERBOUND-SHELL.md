# #21 Folio Admin responsive Paperbound kabuğu (kısmi)

Bu PR, mevcut React/Vite Admin açılış sayfasını aynı Paperbound semantik tokenlarıyla mobil/tablet/desktop kullanılabilir bir **dürüst gezinme kabuğuna** dönüştürür.

- Üstbar 76px; desktop yan menü 258px; geniş ekranda 300px inspector. 0–1023px aralığında menü dokunmaya uygun, yatay kaydırılabilir erişilebilir nav'a dönüşür; tüm sayfa yatay taşmaz. 320/390/768/1024/1440/1920 Chrome E2E zorunlu.
- Gerçek browser path ve back/forward: `/admin/dashboard`, `/admin/works`, `/admin/authors`, `/admin/editions`, `/admin/rights`, `/admin/import`, `/admin/files`, `/admin/members`, `/admin/moderation`, `/admin/audit`, `/admin/settings`. Navigasyon `<a href>`, `pushState` ve `popstate` ile çalışır. İçerikler gerçek API tamamlanana kadar izin-gerektirir durumu gösterir.
- TR/EN dil anahtarları ve OS dark/light Paperbound tokenları gerçektir; 44px tıklanabilir hedefler, görünür klavye odak, skip link, durum duyurusu ve reduced-motion ilkeleri bulunur.
- Otomatik kaynak senkronu, AI çeviri/TTS üretimi ve harici sağlayıcı ekranları **AFTER-V1** olduğu için link veya aktif komut olarak sunulmaz. Gerçek ürün sayıları, sahte başarılı import, hayalî kullanıcılar veya sahte canlı istatistikler gösterilmez.

**Önemli:** Bu UI değişikliği, 30 Admin sayfasının CRUD/gerçek verilerle tamamlandığı iddiası değildir. İzin doğrulama, ekranlara bağlı gerçek API, Admin MFA ve RBAC (#30/#43), 7 sekmeli eser çalışma alanı (#22), private storage/review (#26/#14) ve bütün formlar/tablolar sonraki bağımlı görevlerdir. Sahte oturum oluşturulmaz ve gerçek üyelik verisine istemci doğrudan ulaşamaz. Son kabul için ayrıca görsel snapshot, ekran okuyucu ve ilgili native test kanıtı gerekir.

CI: `e2e/admin-navigation.spec.ts` rota/geri-ileri/EN/AFTER-V1 disabled ve 6 viewport genişliğinde klavye + yatay overflow negatif testlerini, önceki `e2e/foundation.spec.ts` ile birlikte çalıştırır. Production dağıtımı veya gerçek kullanıcı verisi yok.
