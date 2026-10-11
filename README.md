# Folio

Türkçe/İngilizce, e-kitap + RSVP hızlı okuma + hazır sesli kitap + temel sosyal kütüphane için Expo iOS/Android/Web uygulaması ve web admin.

> **Durum:** MVP geliştirmede; production dağıtımı yok. Açılmış PR veya CI başarısı, özelliklerin tamamlandığı anlamına gelmez.

## Aktif MVP kesiti

**Karar ve görev haritası:** [#170](https://github.com/VOX-Medya/folio/issues/170) · [MVP yürütme ve kabul](docs/62-MVP-EXECUTION-PLAN.md).

İlk sürüm: güvenli oturum, yazar/eser araması, kişisel raf, basit CLI manifest/SHA ile onaylı kitap importu, minimal admin yayın hakkı, normal okuyucu, RSVP WPM/grup, hazır ses oynatıcı, sunucu okuma konumu, TR/EN responsive UI, davet koduyla karşılıklı arkadaşlık. İlk release için 1.000 kitap, tam yedi-sekmeli editor, kişisel EPUB/PDF, yorumlar, istatistik, offline indirme ve eksiksiz demo ekran seti şart değildir; bunlar AFTER-MVP'de.

**Değişmez:** kullanıcı/arkadaş araması yok; yalnız kitap/yazar araması. Özel dosya/hesap izolasyonu, oturum/MFA/RBAC/CSRF, kaynak hash, telif ve ülke yayın kapısı kapatılamaz. OCR, AI metin düzeltme/otomatik çeviri/TTS, dış kaynak sync yok. Orijinal yayınevi kapağı kullanılmaz.

## Mimari

`apps/server` NestJS REST/OpenAPI; `packages/db` PostgreSQL+Drizzle/pg-boss; `apps/mobile` Expo Router/React Native Web; `apps/admin` React/Vite/Tailwind; `packages/contracts`, `packages/ui-tokens`, `tools/folioctl` ve `infra` aynı pnpm monorepo'da. Ayrı mikroservis/Kubernetes/Redis yok.

## Geliştirme ve test

**Ana ve tek otomatik yürütme ortamı GitHub-hosted Ubuntu Actions**. Kullanıcı Desktop Commander/SSH cihazına bağlanılmaz. Kod/doküman değişikliği GitHub issue referanslı branch ve PR üzerinden yapılır.

- Normal PR: hızlı `check` (lint, TS, unit, OpenAPI).
- `ci:full` PR, `main` push veya manuel `validation=full`: bir kez Folio-only PostgreSQL/gerçek HTTPS kritik smoke, Chrome E2E ve Expo Web/Android/iOS **JavaScript export**.
- Manuel `validation=extended`: ek kapsamlı corpus, görseller, sentetik ClamAV, lisans, audit raporu ve non-deploy Docker. Bu işlem her push'ta tekrarlanmaz.
- Advisory audit geliştirmede bilgi amaçlıdır. **Prod güvenlik/backup/rights/cihaz QA ve açık yayın onayı** #48'in sorumluluğunda kalır. Actions production sunucu veya gerçek native iOS/Android test cihazı değildir.

## Belgeler

- [MVP proje talimatları](docs/63-MVP-PROJECT-INSTRUCTIONS.md)
- [Yeni sohbet devam promptu](docs/64-NEW-CHAT-CONTINUATION.md)
- [Kapsam](docs/00-PRODUCT-SCOPE.md) · [Mimari](docs/01-ARCHITECTURE.md) · [Görev haritası](docs/08-ISSUE-ROADMAP.md)
- [Tasarım](docs/03-DESIGN-SPEC.md) · [Import](docs/05-IMPORT-EXPORT.md) · [Test/yayın](docs/06-TEST-RELEASE.md)

**İlerleme:** GitHub'daki geçerli `scope:v1`+`type:task` issue'lardan yalnız `closed/completed` olanlar tamamlanır; epic, duplicate ve `scope:future` dahil edilmez. Proje yüzdeleri gerçek GitHub durumuna göre yeniden hesaplanır.
