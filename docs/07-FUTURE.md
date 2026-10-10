# V1 sonrası kapsam (LATER: KİLİTLİ)

**Bu belgede bulunan herhangi bir özellik V1 milestone'a taşınamaz.** Burada issue oluşturulması, ürün geliştirmesi izni değildir. Yalnız V1'in kalıcı veri/adapter sözleşmelerinin gelecekte bozulmaması için dokümantasyon yapılır.

## F2 içerik otomasyonu
- Source adapter implementations: Project Gutenberg RDF/CSV + mirrors, Standard Ebooks OPDS ve GitHub, Turkish Wikisource/WS Export, ek kaynaklar; cursor sync, rate limit, delta/rights check, manual review staging, conflict merge.
- Admin kaynak mapping, source sync schedule/health, sürümlü connector config ve geri alma; kaynak kitap verisi kanonik kaydı doğrudan overwrite edemez.
- Local manuscript/ebook parsing classifier: Jev API ve self-hosted Laya benchmark (özellikle TR/EN), sadece şüpheli blok semantik türü. OCR/düzeltme/metin üretimi gelecekte de yasak, izin politikası değişmeden.
- Otomatik lisans ülke değerlendirme destek araçları; hukuk review hiçbir zaman model çıktısına körlemesine bırakılmaz.

## F2 yerel/cloud üretim
- TranslationProvider implementasyonu (Qwen local, batched cloud API) + glossary/character names/chapters; paragraph alignment and immutable translations; editor review.
- NarrationProvider implementations (Chatterbox, Piper, bulut TTS). Per chapter chunk, voice/model/version, audio/text hash, replacement/rollback, voice license rights, real-time factor/maliyet ölçümü.
- GPU worker registry: outbound HTTPS auth worker pull, heartbeat, lease, retry/idempotent, chunk transfer, night window; home GPU kapalıyken kullanıcı uygulaması etkilenmez. Scale cloud fallback.
- Provider health/failover/routing, cost budgets, metrikler, admin active source/generation queues.

## F3 sosyal/ticari
- Kullanıcılar arası özel mesajlar: moderation, report/block abuse and privacy.
- Book clubs/reading challenges/club moderation; profil gizliliği.
- Independent author publishing portal and author rights verification; editorial workflow, takedown and payout only after business decision.
- Premium subscription / credit accounting / store billing, trials and entitlement checks. Ücretsiz V1'in paid feature paywall'una dönüşmesi baştan kararlaştırılmış değildir.
- AI-powered personalization, advanced multi-language UI or locale-specific tax/business compliance as expansion.

## Yatay ölçek ve operasyon
- Yerel dosyalardan S3-compatible blob store migration; stateless workers scale, ayrı Postgres/managed DB, object CDN; gerekirse Redis veya dedicated job infra, fakat şimdi kurma.
- Dedicated analytics/warehouse later only if Postgres aggregates cease to meet SLO.
- i18n beyond TR/EN, accessibility language support and territory rights matrix expansion.
- Corporate/publisher integrations only after source copyright validation and business agreement.

## Future issue tamamlanma kuralı
- Milestone **AFTER-V1**, label **scope:future**, hiçbir V1 parent'ın bloklayıcı bağımlılığı olamaz.
- Issue açıklaması ilk satır "DO NOT IMPLEMENT DURING V1"; sonraki aşama karar kapısı (kullanıcı talebi, operasyonel sınır, kapasite, bütçe ölçümü).
- Aday işin gelecekte yeniden değerlendirmesi gerektiğinde önce hacim ve manuel çalışma dakikaları ölçülür, otomasyon ROI karşılaştırılır; sessizce V1'e sokulmaz.
