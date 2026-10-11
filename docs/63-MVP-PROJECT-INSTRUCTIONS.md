# FOLIO | MVP Proje Talimatları

**Repo:** https://github.com/VOX-Medya/folio
**Karar:** GitHub issue #170, `docs/62-MVP-EXECUTION-PLAN.md`.
**Dil:** Türkçe, teknik, kısa ve doğrudan. Yalnız doğrulanmış işi tamamlanmış say.

## Hedef ve kapsam
Öncelik **temel çalışan sürümü** üretmek; geniş V1 tasarımının tüm ekranlarını, eski istisnai testleri veya 1.000 kitabın tamamını çıkış bağımlılığı yapma. V1/MVP, `scope:v1` + `type:task` etiketli **29 geçerli görev** olarak yeniden düzenlendi: temel mimari (5), katalog/admin (9), Expo/okuyucu (8), gizlilik/arkadaşlık/roller (3), test/yayın (4). İlk 4 kabulü tamamlanan temel görev sayılabilir; sayı her oturumda yeniden doğrulanır.

MVP: tek NestJS + PostgreSQL/Drizzle/pg-boss backend, Expo iOS/Android/Web responsive, React/Vite minimal admin; TR/EN giriş/temel profil; eser-yazar arama, kişisel raf, hazır kitapları manifest+SHA ile CLI dry-run/apply; telif onayı olmadan yayımlamama; normal okuyucu + RSVP (WPM/grup) + **hazır** ses oynatma; server'da kalıcı okuma konumu; davet koduyla karşılıklı arkadaşlık. Kullanıcı araması, kullanıcı keşfi, öneri yok. Kapak orijinal yayınevi görseli değil basit Folio tipografi.

AFTER-MVP: #15, #17, #20, #22, #24, #25, #37, #38, #41, #42, #44; ayrıca eski AFTER-V1 işleri. Bunları MVP'de geliştirme, bağımlılık yapma veya yüzde hesabına katma. Metin düzeltme/üretme, OCR, otomatik çeviri/TTS, dış kaynak senkronu, ayrı mikroservis/Redis/K8s, ödeme sistemi yok. 1.000 eser uzun vadeli içerik hedefidir; ilk sürüm için lisanslı küçük koleksiyon yeterlidir.

## TEK geliştirme ve test ortamı: GitHub Actions
**GitHub-hosted Ubuntu Actions** üzerinden `CI` çalıştır. Desktop Commander `mehmet` dahil **hiçbir remote desktop, SSH bağlantılı kullanıcı cihazı, yerel terminal, başka geliştirme servisi arama/bağlanma/çalıştırma**. Repo kodunu GitHub connector/API ile branch+PR üzerinde düzenle; GitHub Actions CI loglarıyla test et. Github Actions ephemeral CI runner'dır; production sunucusu veya sürekli çalışan otonom ajan değildir. Çalışmayı sadece bu sohbetin aktif işlemleri ve gerçekten kurulmuş GitHub CI üzerinden yap, yapmadığın background işini vaat etme.

Normal PR: hızlı `check` (lint, type, unit, OpenAPI). `main`: tek `full-regression`, izole Folio PostgreSQL/gerçek HTTPS ve kritik API smoke + Chrome + Expo JS export. Veri şeması/auth/owner/private/rights değişikliğinde PR'a `ci:full` ekle ve sonucu gör. İsteğe bağlı Actions manuel `fast/full/extended` seçenekleri. **Gecelik tekrar, gereksiz Docker, altı ayrı görsel örnek, gerçek ClamAV apt ve tüm eski corpus'u her commit'te çalıştırma.** `extended` yalnız ilgili hata/istek veya yayın öncesi kanıt için kullan. Expo JS export gerçek Android/iOS native testi değildir.

Dev dependency security-audit uyarısı bilgi amaçlıdır; geliştirme PR'ını tek başına durdurmaz. Ancak **auth/MFA/RBAC/CSRF, private-owner kontrolü, hash/MIME/boyut sınırları, telif/ülke yayın kararı, audit ve kullanıcı veri izolasyonu asla kapatılmaz**. Bilinen advisory riski #48 release gate'te kalır. Kod sırrı/.env, gerçek veri veya telifli içerik commit etme. Production build/deploy ve canlı veri/alan adı değişikliği **açık insan onayı olmadan yok**.

## Oturumda zorunlu yürütme
1. GitHub `main`, açık PR, en güncel CI, geçerli V1 issue ve bağımlılıkları kontrol et; tamamlanan/eksik görev sayısını doğrula.
2. `docs/62-MVP-EXECUTION-PLAN.md` sırasıyla bağımlılığı çözülmüş **en erken açık dikey MVP görevine** yönel. Birden çok alt-özellik PR'ı açıp kabul kriterini sonsuza erteleme. Önce çalışan özelliği bitir ve ilgili issue'yu kapat.
3. Tek issue'ya odaklan, uygun testleri seç. Küçük ölçülebilir teslim ve kanıtlı PR/merge; 401/403/409 gibi ilgili kritik negatif testler dışında alakasız edge-case matrisi ekleme. Test fail ise düzelt; her alt adımda tüm eski smoke'ları yeniden tetikleme.
4. Gerçek kullanıcı/DB/özel dosya güvenliği bozulamaz. Ürün için zorunlu olmayan insan tasarım onayı, mağaza hesabı, iOS signing, telif/hukuki onay, canlı alan adı ve yedek lokasyonu gibi bağımlılıkları ilgili issue (#48/#47) üzerinde `blocked` notuyla bırakıp başka bağımsız işe geç. Onay/test uydurma.
5. Issue kabulü: gerçek çalışan kod + ilgili unit/contract ve uygun smoke + CI URL/doküman. Yalnız hepsi karşılanırsa `closed/completed`; yarım iş açık kalır. Epic, duplicate ve future tamamlanma yüzdesine dahil edilmez. Gereksiz yeni servis, editoryal review ledger, tam platform ekran matrisi veya kapsam dışı entegrasyon geliştirme.
6. Her yanıtta iş, test/PR, engel ve sıradaki görev hakkında kısaca bilgi ver. Otonom yetkili kodlama, commit, PR, CI, issue düzenleme için tekrar izin isteme. Production veya geri döndürülemez kullanıcı/veri işlemi için dur.

## HER yanıtın sonunda BİR kez zorunlu rapor
**Folio İlerleme Durumu (son GitHub doğrulaması: YYYY-AA-GG)**
- V1-00 Temel Mimari: %X,X (a/b)
- V1-01 Katalog ve Admin: %X,X (a/b)
- V1-02 Expo ve Okuyucu: %X,X (a/b)
- V1-03 Gizlilik, Arkadaşlık, Roller: %X,X (a/b)
- V1-04 Test ve Yayın: %X,X (a/b)
- **GENEL MVP/V1: %X,X (a/b)**
- **Aktif faz: V1-XX | faz ilerlemesi: %X,X**

Yüzde = `state=closed` VE `state_reason=completed` olan geçerli issue sayısı / toplam geçerli `scope:v1`+`type:task` issue sayısı ×100. `duplicate`, `scope:future`, epic veya sadece PR merge edilmiş açık issue tamamlanmış sayılmaz. Bir ondalık göster. GitHub erişimi başarısızsa oran uydurma; "doğrulanamadı" ve en son doğrulama tarihini belirt. Bu rapordan sonra metin ekleme, raporu yanıtta tekrar etme.
