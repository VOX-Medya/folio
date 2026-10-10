# Folio issue yürütme haritası

## Milestone 1: V1-00 | Epic #1
Temel sıra: #7 monorepo/CI, #8 tasarım token freeze, #9 NestJS API, #10 PostgreSQL + Drizzle + pg-boss, #11 izole Ubuntu mehmet laboratuvarı.
Çıkış: temiz kurulum, DB migration, build/test, tasarım doğrulaması; üretim dağıtımı yok.

## Milestone 2: V1-01 | Epic #2
Kanonik katalog ve haklar: #12 eser/yazar, #13 metin revizyonları, #14 telif/ülke kısıtları, #15 hazır TR/EN çeviri hizalama, #16 hazır ses revizyonu, #17 Folio kapak.
Import/işleme: #18 paket şeması/CLI, #19 dry-run/apply/resume, #20 OCR'siz EPUB/PDF kabul ve semantik ayrıştırma, #26 özel dosya alanı.
Admin: #21 kabuk, #22 7 sekmeli eser çalışma alanı, #23 QA/onay/yayın, #24 import/export, #25 manuel çeviri/ses/kapak editörü.
Not: #27 ve #28 mükerrer olarak kapatılmıştır; uygulama işleri #25/#26 altında tutulur.
Bağımlılık: #10 -> #12/#13/#14 -> #18/#19 -> #22/#23/#24. #15/#16 -> #25. Yayın için #14 zorunlu.

## Milestone 3: V1-02 | Epic #3
#29 Expo iOS/Android/Web responsive, #30 auth/onboarding/admin MFA, #31 ana sayfa/keşif/raflar, #32 eser detay/dil/indir, #33 normal okuyucu, #34 RSVP, #35 hazır ses oynatıcı, #36 ortak cursor/offline/language sync, #37 notlar/alt çizim, #38 offline cache.
Bağımlılık: #13 öncesinde okuyucu yok; #15/#16 önce hazır medya; #30 önce kişisel kütüphane; #36 çapraz mod kontrolüyle kabul.

## Milestone 4: V1-03 | Epic #4
#39 profil/gizlilik, #40 sadece davetle arkadaşlık (kullanıcı araması kesin yasak), #41 yorum/sosyal akış, #42 gerçek okuma istatistikleri, #43 admin RBAC/moderasyon/audit, #44 uygulama içi bildirim/i18n.
Bağımlılık: #30 auth -> #39/#40; gizlilik matrisi sosyal API ve yorumlarda zorunlu.

## Milestone 5: V1-04 | Epic #5
#45 unit/integration/visual/E2E, #46 güvenlik kötüye kullanım testleri, #47 offsite backup/restore ve yük, #48 üretim yayını için açık onay kapısı.
Testler sadece son fazda değil her PR'da yapılır. Ubuntu lab ayrı veritabanı kullanır. iOS testleri uygun macOS/EAS ortamında ayrıca tamamlanır.

## Milestone 6: AFTER-V1 | Epic #6 | GELİŞTİRİLMESİ YASAK
#49 Gutenberg, #50 Vikikaynak, #51 Standard Ebooks/adaptör SDK, #52 kaynak sync admin, #53 Jev/Laya, #54 otomatik çeviri, #55 TTS üretimi, #56 RTX/GPU worker, #57 provider health/routing, #58 DM/kulüp, #59 yazar yayıncılığı, #60 abonelik/billing, #61 S3/CDN/yatay ölçek, #62 ek dil/ülke.
Bu işler V1'de yalnız geleceğe uyumlu veri/adapter portlarıyla temsil edilir; çalışma zamanı ve kullanıcıya açık entegrasyon asla yapılmaz.

## Tasarım ve test çıkış kuralı
Kaynaklar: design/reference/folio_ui_tasarim_studyosu.html (58 demo ekranı), design/reference/folio_admin_tasarim_studyosu.html (30 demo ekranı); docs/03-DESIGN-SPEC.md.
Mobil 320/390, tablet 768, desktop 1024/1440/1920; TR/EN, light/dark, klavye, reduced motion, erişilebilirlik; responsive desktop gerçek düzen, büyütülmüş telefon değil.
Orijinal yayınevi kapakları YOK; Folio tipografik kapak. RSVP akışında sayfa/dipnot/yayınevi notu YOK ama kaynak içerik kaybolmaz. OCR/yeniden yazma YOK.
1.000 özgün eser (500 Türkçe + 500 İngilizce) hedefi, çeviri ve hazır ses yerelde üretilir; 25-50 kitaplık hash'li paketlerle SSH CLI dry-run + apply ve admin yayın kontrolünden geçer. Kitap içerik QA ve hak denetimi tamamlanmadan public olmaz.
Her issue kapanırken API/DB değişimi, test kanıtları, mobil/tablet/desktop ekran görüntüleri ve rollback yöntemi kaydedilir. Gelecek işi V1'e almak ayrı kapsam değişikliği kararı gerektirir.