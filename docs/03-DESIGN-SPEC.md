> **MVP kapsam üst kararı (11.10.2026):** Bu dosyadaki 58 mobil/30 admin ekran referansı gelecek için tasarım kaynağıdır, **MVP'nin tamamlanma matrisi değildir**. MVP yalnız #29–#36, #21/#23 ve #39/#40/#43 için gerekli çalışan responsive yolları teslim eder; 6 viewport × 2 dil × 2 tema her PR'da istenmez. Kaynak: [docs/62-MVP-EXECUTION-PLAN.md](62-MVP-EXECUTION-PLAN.md).

# Folio Tasarım Sözleşmesi (mobil + tablet + masaüstü web + admin)

## Kaynak ve ürün kararı
- Kaynak HTML dosyaları: ../design/reference/folio_ui_tasarim_studyosu.html (58 demo ekranı, 10 görsel konsept); ../design/reference/folio_admin_tasarim_studyosu.html (30 demo ekranı, 6 görsel tema).
- Bunlar çalışır ürün değil, interaktif tasarım referansı. Örnek sayaçlar, kitapların hak durumları ve geleceğe dönük modüller sahte/demo veridir. Her ekran için gerçek durum modeli yapılmalı.
- Kullanıcı henüz nihai tema seçmedi: geliştirme için varsayılan referans **Paperbound / Parşömen**. Final token seçimi UI dondurma issue'sunda onaylanacak; aksi karara kadar bu varsayılanı kullanın, geliştiriciler kendi zevkine göre farklı renk/arayüz çizmesin.
- Mobil Paperbound Parşömen renkleri: background #F5F0E7, surface #FFFDF8, ink #26332B, secondary #788276, line #DDD8CD, accent #4F6955, tint #E5ECDF. Koyu mürekkep paleti bir alternatif, otomatik dark mode ise tokenları semantik eşleştirmeyle kullanır.
- Admin Paperbound başlangıç: bg #F6F4ED, surface #FFFEFA, surface2 #EEEAE1, ink #26372C, muted #758076, line #DFDFD5, accent #476E54, tint #E4EBE0, radius 17px.
- Ana UI font DM Sans; alternatifler Manrope, Plus Jakarta Sans; editoryal başlık Fraunces; okuma fontu ilk varsayılan Georgia, kullanıcı değiştirebilir. Lisanslar, lokal font paketleri ve web font fallback ayrıca doğrulanır.
- Tasarım semantik tokenları: bg/surface/surface2/ink/muted/line/accent/accent-on/tint/success/warning/error/focus, density, typography scale, cornerRadius, border, shadow, spacing. Aynı isimli tokenlar mobil/web/admin dönüşümlerinde kullanılır.
- Prototipin diğer 9 konsepti: Clearspace, Nightfall, Warm Press, Deep Chapter, Monograph, Aurora, Kinetic, The Archive, Soft Story. Admin diğer 5: Warm Press, Nightfall, Deep Chapter, Quiet Modern, Monograph. Alternatif ekranlar referanstır, 10 ayrı tema motoru V1 şartı **değildir**.
- Tasarım değişkenleri: responsive layout; ekran okuyucu ve erişilebilirlik; font ölçekleme; tutarlı başlık/eylem hiyerarşisi; dinamik iki dil uzunlukları; loading/empty/error/permission/offline/retry/readonly/withdrawn/import-in-progress states. Bunlar gerçek ekran olarak tasarlanmalıdır.

## Responsive davranış (önerilen token sınırları)
- 0–599px telefon: tek kolon, alt 5 elemanlı sabit navigasyon, safe-area, e-book okuyucu tam ekran; dokunma hedefi en az 44×44 pt.
- 600–1023px tablet: gerektiğinde iki kolon, genişletilmiş kitap listesi, bölümler slide-over; alt navigasyon ya da yan menü, kısa ekranda taşma testi.
- >=1024px desktop web: kalıcı sol navigasyon + içerik 2–4 kolon, maksimum okuyucu satır genişliği 60–80 karakter, seçmeli yan panel (içindekiler/notlar), klavye kısa yolları, odak halkaları ve hover states.
- 320px dar telefon, 390px tipik telefon, 768px tablet, 1024px laptop, 1440px desktop, >=1920px geniş ekran test edilir. Dokunmatik webde hover'e dayalı tek işlem bulunmaz.
- iPad/tablet yatay, split-view, OS safe areas, ekran zoom, web browser resize. PDF/EPUB okuma alanı responsive olup hız okuma odak alanı taşmaz.
- Ekran görüntüsü boyutları/cihaz ölçüleri asla kaynak kitap sayfa numarasıyla eşitlenmez.

## Mobil ekranların tamamı (kaynak demo 58)
**V1:** Splash, Welcome, Sign in, Sign up, Walkthrough, Reading interests (6).
**V1:** Home, My library, Collections, Collection detail, Book detail, Editions & translations, Upload book, Book matching, Book processing status, Downloads (10). **FUTURE:** Narration production queue (bu demo kullanıcının önceden üretilmemiş sesi için iş kuyruğu; V1 ses dosyaları mevcutsa dinlenir).
**V1:** Ebook reader, Reader settings, RSVP, Audiobook player, Voice selection (yalnız hazır ses varyantları), Chapters, Highlights, Notes, Book-internal search, Reading history (10).
**V1:** Discover, Book/author search, Search results, Author page, Public-domain library, Curated recommendations (manuel/editorial, AI öneri yok), Want to read, Book reviews, Write review (9).
**V1:** Social feed, Friends, Add friend via invite, QR invite, Enter friend code, Friend requests, Friend profile, Reading activities, Comments (9). **FUTURE:** Book clubs, Messages (2).
**V1:** My profile, Edit profile, Privacy, Reading statistics, Goals, Notifications, Settings, App language (8). **FUTURE:** Premium membership, Author studio, Publish book (3).
Toplam 6 + 11 + 10 + 9 + 11 + 11 = 58 demo ekranı; V1 52 ekran, gelecek 6 ekran. V1 navigasyonda future ekranlar aktif hedef olamaz. "Narration queue" ses dinleme/indirme durumunun kendisiyle karıştırılmaz.

## Mobil kritik UX
- Onboarding: 2 dil + konu ilgisi + hesap açma/oturum + gizlilik onayı + continue-later; kullanıcı son tamamlanan adımda kalır.
- Home: okumaya devam et ilk görünümde; kişisel/ortak kütüphane ve küratör seçkileri; arama yalnız kitap/yazar için.
- Book cards: tek tip Folio kapak, yazar, eser dili, hazır diller, ses var/yok, ilerleme; orijinal yayınevi kapağı yok.
- Book detail: başlık/yazar/konu, hukuki erişim ülkesine göre, mevcut baskı/çeviri/seçilebilir ses, toplam bölüm, okumaya devam et / kitaplığıma ekle / dinle / incelemeler, dosyanın kişisel mi ortak mı olduğu.
- Upload: EPUB/PDF file picker (web drag-drop), boyut/şema/DRM/metin sırası kontrolü, adım sayacı, invalid-file hata mesajı; OCR varmış gibi teklif etme.
- Reader: maksimal sakin okuma, kullanıcı font/font size/line height/page margin/theme, bölüm listesi, not/alt çizim, konum; ekranda sayfa sayıları RSI akışına sızmaz.
- RSVP: görsel odak/sabit hizalama, WPM varsayılan prototip 320, configurable 1+ grup boyu (prototip 2); duraklat/oynat/ileri-geri/yeniden başlat; noktalama gecikmesi seçenek olarak; background'da otomatik duraklat; canlı progression.
- Audio: ready-file language/voice variants, 0.75–2.0× speed aralığı ve gerçek player desteği test edilmeli, chapter selection, scrub, sleep timer, background/play-pause, lock-screen media controls on native, reading sync.
- TR/EN switch: aynı work kaydı, ayrı revision; anchor alignment doğrulanmadan bir dilin kelime sayısı diğerine kopyalanmaz; kullanıcıya hizalama belirsizliğinde uyarı.
- Social: no people search, no username discovery, no contacts sync; sadece code/QR/deeplink ile davet; karşılıklı kabul, süresi dolmuş davet, engellenmiş profil, private visibility states.
- States: her ekranda skeleton/empty/error/loading/deleted/unavailable, retry, offline pending, permission, unsupported format. Kötü kalite kitap kullanıcıya hiç yayınlanmaz.
- Web: browser back/forward deep link routable, klavye, odak, alt-tab; normal reader max-width ve yandan notlar; RSVPs keyboard shortcuts Space (pause), arrows (word step), Esc (exit). Formlardaki butonlar gerçek aksiyonlarla bağlı.

## Kapak render
- Tipografik tek şablon ailesi; input work UUID, edition language/title, canonical author(s), genre palette, template version, optional editorial override.
- Standart kapak dışı orijinal kaynak kapak kullanılmaz. Uzun başlık iki/üç satır, satır sonları deterministik; aksan ve diakritik örnekleri, kontrast, font fallback; küçük listede başlığın okunabilirliği.
- Kapak değişimi içerik/ilerleme revizyonu değiştirmez. Render sonucu farklı çözünürlüklerde aynı görsel sistemine sahiptir.

## Admin web: 30 demo ekranı
**V1 tam işlevsel (en az):** Dashboard, analytics, all works, work workspace (Overview/editions/content/translations/audio/rights/history tabs), authors, editions/languages, text revisions, translation library (manuel import/edit/approve), audio library (asset upload/replacement), cover templates, copyright/rights, intake quality review (manuel import QA), local job statuses (import/validation), files/storage overview, Import/Export, Backup/Restore status, members, friendship/privacy, moderation, general settings, roles/permissions, audit log.
**FUTURE/BLOCKED:** Source integrations (sync), source field mappings, incoming remote source staging, automated processing rules, translation production queue, TTS production queue, remote/cloud workers, active provider switching. Bu ekranların tasarım kabuğu veya future duyurusu bulunabilir ama API/çalışan entegrasyon yazılmaz; metrikler sahte aktif gibi görünmez.
- Admin masaüstü öncelikli: sidebar 258px, topbar 76px, sağ inspector ~300px prototip; tablet daralınca inspector drawer, mobilde admin kritik edit davranışları kullanılabilir/sınırlı mesajlı; asıl eser editörü >=1024px optimize.
- Tablo: arama, işlevsel sütun sıralama, sayfalama, filtre, toplu işlem önizlemesi; kontrolsüz toplu yayın yok. Alan etiketleri, hata nedenleri ve rights durumları anlaşılırlık taşır.
- Eser detay 7 sekme: Genel, Baskılar, Metin, Çeviriler, Ses, Haklar, Geçmiş. Yan yana kaynak/işlenmiş metin diff; paragraf tipini düzenleme, kaynak değişmez; yeni kontrollü revizyon oluşturma.
- Yayın iş akışı: draft -> processing/review -> approved -> published, archived/withdrawn; yayın öncesi rights + content integrity + asset checks.
- Kritik işlemler confirm + audit log, önceki değer, değişiklik nedeni; kaydetme başarı feedback'i backend sonucu olmadan gösterilmez.
- Admin renk/tema seçenekleri kayıt olabilir ama V1'de gerçek admin görünüm için Paperbound base ve high-contrast semantic tokens tutarlı.
- Kabul görsel testleri: Chrome/Safari/Firefox ve Android/iOS simülasyonlarında 320/390/768/1024/1440; light/dark, TR/EN, reduced-motion, VoiceOver/TalkBack, WCAG AA hedefi, yüksek font ölçekleri.

## Uygulanabilir ekran sözleşmesi (#8)
Kaynak HTML prototiplerindeki 58 mobil ve 30 admin ekran kimliği, V1/gelecek ayrımı, eylem ve hata/çevrimdışı/gizlilik durumları `docs/10-UI-SCREEN-MATRIX.md` içinde tutarlı biçimde doğrulanır. `node tools/design/generate-screen-matrix.mjs --check` prototip/eylem kapsamını ve çıktının güncelliğini denetler. Ortak açık/koyu Paperbound tokenları `packages/ui-tokens/src/index.ts` üzerinden admin ve Expo başlangıç kabuğuna uygulanır. Bu sözleşme V1 ekranlarının tamamının uygulanmış veya kullanıcı tarafından nihai görsel olarak onaylanmış olduğu iddiası değildir.

## Tasarim sozlesmesi kabul kaniti (#8, 10 Ekim 2026)
Paperbound kapsam matrisi, 88 kaynak referansi / 74 V1 / 14 AFTER-V1 kisitini ve her V1 ekraninin eylem/durum/cihaz yerlesimi politikasini otomatik test eder. `docs/18-DESIGN-CONTRACT-ACCEPTANCE.md` 320/390/768/1024/1440/1920 Chrome E2E, dark/light ve kontrast test kanitlarini listeler. Bu tasarim kontratinin dondurulmasidir; 74 ekrani yapilmis, butun gercek hata/offline/yetki akislari denenmis veya insan son tasarim onayi alinmis anlamina gelmez.

## Admin Settings MFA UX kısmi kanıtı (#30)

`/admin/settings` altındaki `AdminMfaPanel` Paperbound semantik renk tokenlarıyla TR/EN, açık/koyu tema, 390px mobil/desktop responsive ve >=44px etkileşim hedeflerine uyar. HTTP/SSR'da parola, TOTP kodu ve gizli kurulum anahtarını göstermez; gerçek admin oturumu için dogrudan HTTPS, HttpOnly cookie, ayni origin CSRF gerekir. Kayıt/confirm/verify/logout yalnız backend sonucu üzerine durum değiştirir; başarısız sunucu, yetki, offline ve loading durumlarını açık gösterir. E2E ve Vitest sözleşmesi `docs/48-ADMIN-MFA-WEB-UX.md` altında. **Geri kalan 30 admin ekranının uygulanmış olduğu, production erişimi, onaylı MFA recovery veya native uyum iddiası değildir.**
