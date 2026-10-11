# Folio | MVP ürün kapsamı (11 Ekim 2026)

**Geçerli karar:** [#170](https://github.com/VOX-Medya/folio/issues/170). **Aktif görev ve çıkış haritası:** [docs/62-MVP-EXECUTION-PLAN.md](62-MVP-EXECUTION-PLAN.md). Bu belge önceki 40-görev tam V1 listesine göre **daraltılmış ilk ürün** kapsamını tanımlar. Önceki uzun-term hedeflerin silinmesi veya otomatik tamamlanması anlamına gelmez.

## İlk sürümün çalışması gereken yolu
1. Hesap ve güvenli oturum. Türkçe/İngilizce UI; responsive telefon/tablet/masaüstü Expo Web, Android/iOS ortak kod. Native mağaza imzaları ve gerçek cihaz kabulü release #48'de.
2. Yazar ve eser arama, gerçek katalog/detay, kullanıcı rafı, okuma kaldığı yerden devam.
3. Yerelde **önceden hazırlanmış** ve hakları onaylanmış eserleri SHA-256'lı sürümlü basit manifest+CLI ile **dry-run/apply**; bozuk paket reddi, idempotent kayıt, draft ve manuel yayın kararı. İlk yayın 1.000 eser ile bloke edilmez. 500 TR + 500 EN katalog genişleme hedefi olarak korunur.
4. Normal paragraf/bölüm okuyucusu, RSVP WPM/kelime grubu ve **hazır ses dosyası** oynatma; seçilen kitap/revizyon konumunu tek backend'de kalıcı saklama.
5. Özel veriler varsayılan gizli, minimum kullanıcı profil ayarları, davet kodlu karşılıklı arkadaşlık, temel admin rol ve değişiklik günlüğü.
6. Basit Folio tipografik kapak/yer tutucu; yayınevlerinin orijinal kapakları kullanılmaz. Kitap/yazar araması var, kullanıcı araması ve arkadaş önerisi **yok**.

## Bu kesitte yok
AFTER-MVP issue'lar: #15 derin N:M çeviri eşleme, #17 bağımsız kapak motoru, #20 kullanıcı EPUB/PDF yükleme ve parser, #22 yedi-sekmeli editör, #24 GUI import sihirbazı, #25 zengin çeviri/ses editörü, #37 not/alt çizim, #38 offline indirme, #41 yorum/akış, #42 analitik/streak, #44 bildirimler. İlgili metadata/API genişleme noktaları hazırlanabilir; kullanıcıya işlevselmiş gibi gösterilemez.

Eski AFTER-V1: Gutenberg/Wikisource/Standard Ebooks otomatik kaynak senkronu, OCR/AI ile metin değiştirme, otomatik çeviri/TTS, GPU/cloud pipeline, üyelik/ödeme, mesajlaşma/kulüpler, yaratıcı yayıncılığı, S3/CDN, gereksiz mikroservisler. **Bunları MVP'ye bağımlılık yapma.**

## Değişmez sınırlar
- Tek NestJS API + PostgreSQL/Drizzle/pg-boss; Expo/React Native Web ve React admin; Folio-only özel local dosya alanı. Redis/Rabbit/K8s/ayrı Python API yok.
- Başkasının private kitabı görünmez. Backend kullanıcı/oturum/owner/RBAC sınırlarını uygular. CSRF/MFA gereken admin işlemleri güvenli kalır. Kontrolü gevşetmek isteyen geliştirme isteği buna istisna değildir.
- Kaynak metin veya medya uydurulmaz, değiştirilmez, lisans/ülke/çeviri/ses onayı olmadan kamusal yayın yapılamaz. Şüpheli kitap draft/needs-review olarak beklerken bağımsız kitaplar işlenebilir.
- Kalıcı kullanıcı verisi backend'de. İlk MVP'de tam offline cache/sync zorunlu değil, ancak yanlış senkron veya private veri sızıntısı kabul edilmez.
- GitHub Actions Ubuntu yalnız otomatik geliştirme/test; Desktop Commander ve kullanıcı terminaline bağlanılmaz. GitHub Actions production uygulama sunucusu değildir. Production build/deploy veya gerçek veri aktarımı için açık kullanıcı onayı gerekir.

## Kapsam değişiklikleri
Issue #170 karar kaydı; değişen 29-geçerli-MVP hesaplaması GitHub `scope:v1`+`type:task`+state reason üzerinden yapılır. 11 taşınan kayıt `scope:future` olarak açık kalabilir; tamamlanmış sayılmaz. Uygulanan kodun eski dokümanlara göre görünüşte eksik olması otomatik P0 blokaj değildir; önce `docs/62` ve aktif issue'ya bak.
