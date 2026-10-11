> **MVP kapsam üst kararı (11.10.2026):** İlk kesit tek backend kalıcı eser/bölüm/blok konumu, modlar arası temel devam ve sunucu mutasyon doğruluğudur. Tam offline indirme/çoklu cihaz conflict/çeviri N:M hizalama ileri aşamada; bunları #36 temel okuma konumu kabulüne bağımlılık yapma. Özel kullanıcı konumu hiçbir koşulda başka hesaba açılmaz. [MVP kesiti](62-MVP-EXECUTION-PLAN.md).

# Okuma, RSVP, ses ve çapraz cihaz konum sözleşmesi

## Kanonik belge
Tek bir immutable içerik revizyonu bölüm->blok->token akışı sunar. EPUB XHTML güvenli render edilir; HTML semantik ayrılır. PDF yalnız seçilebilir, doğru okuma sıralı metin varsa kabul. OCR, reconstruction ve generative edits YOK. Source offset/locator/tam orijinal metin kanıtı korunur. Tüm bloklar kind: heading/paragraph/footnote/page_number/running_header/publisher_note/preface/poetry/quote/list... ve mode inclusion flag seti içerir.

## Okuma modları
- Normal: semantik HTML render, okuyucu font/size/lineheight/theme/margins; tıklanabilir dipnot ve içindekiler; normal modda metin kırpması yok; yayıncı notları uygun bilgilere yönlendirilir.
- RSVP: reading_included=true metinleri deterministik tokenization, configurable WPM ve grup genişliği, punctuation pauses, play/pause/back/forward, cümle/bölüm göstergeleri. Sayfa numaraları, dipnot metinleri, repeating headers RSVP akışına girmez; belirlenemeyen şüpheli blok content QA'ya takılır. Mevcut kaynaktan kaç kelime işlendiği ölçülür.
- Audio: sadece yerelde hazırlanıp onaylanarak sunucuya yüklenen chapter-based segments, codec/size/duration validation, kesintisiz sonraki bölüm, hız, sleep timer, native background controls, seek/scrub; o ses varyantı bulunmuyorsa hazır değil durumu. V1 audio synthesis yok.
- Language: özgün revizyon ve çeviri revizyonu ayrı. Alignment verified ise aynı pasaj, değilse nearest verified chapter ve kullanıcıya belirsizlik uyarısı. Kullanıcı yalnız kendi erişebildiği revision'lara geçer; global erişim hakları kontrol edilir.

## Progress kimliği
progress key = user_id + selected content_revision_id + reading intent (work reference). Pointer: chapter_id, block_id, token_offset, nearest_source_locator, progress_percent_for_display, last_mode, last_active_at, server_revision. player: audio_variant_id/segment_id/position_ms + nearest text_block_id when known. En son nerede kaldığı cihazlar arasında korunur ve normal/RSVP/audio arasında geçişte aynı anlatı konumu hedeflenir.
- Numaralı sayfa yerine kararlı blok ID, hash+source locator.
- Ekran ölçüsü/pagination değişse ilerleme değişmez. Kullanıcı bir sayfayı geri okuyabilir: max(percent) her zaman doğru değildir.
- İlerlemenin kaydedilmesi: pencereli/debounce periyodik heartbeat, bölüm/seek değişikliği, pause, background, unload, oturum kapanışı. Kayıt sunucudan onay alıncaya kadar locally pending.
- Offline: daha önce indirilmiş lisanslı kitap/asset, yerel veritabanı (Web IndexedDB, Native SQLite) + pending op queue; çakışma duplicate client_op_id ve server_revision üzerinden çözülür; iki cihaz ileri/geri yarışında kullanıcı seçimi veya olay sırası; server authoritative/merge policy testleri.
- Revision update: eski anchor -> yeni blok map diff, kullanıcıyı yanlış bölümde konumlandırma; fallback nearest chapter ve informative banner.
- Personal upload retention: user owns scopes; logout/kullanıcı silme + device secure local cache clear ile ilişki. Paylaşılan cihazda hesap sızıntısı test edilir.

## Analytics
- Session start/stop, active seconds (background/screen off hariç), words delivered RSVP, chapter events, completion, WPM distribution, daily streak, goals. Sessiz gece açık bırakılan player'ı okuma süresi sayma.
- Privacy: analitik rızası, ürün metrikleri aggregation, hesap silme, kişisel okuma aktivitesinin sosyal paylaşımı opt-in/visibility policy; yakın arkadaş profilinde özel kitap adı istemeden açıklanmaz.
- Her isteğin server-side auth+content rights; yerel cache başkalarının erişimine açılmaz.

## Zorunlu E2E senaryoları
1. iPhone bölüm 5 blok38 token12 -> desktop browser aynı pasaj. Ekran fontu/pencere değişse konum korunur.
2. RSVP 320 WPM, grup2 -> normal okuyucu ve geri geçiş, kelime tekrarı kaybı en fazla belirlenen mantıklı tolerans.
3. Audio chapter 3 02:18 -> e-reader'a geç, verified segment mapping varsa yaklaşık metin karşılığı; yoksa chapter only.
4. TR->EN translation paragraphs 1:N; bölüm cümlesi atlamadan en yakın aligned block; unavailable translation hata değil.
5. Offline telefon ilerledi, web başka yerden ilerledi: deterministic conflict; intentional backwards browse bozulmaz.
6. Kaynak revizyonu güncelle, metin bloğu bölündü; eski kullanıcı ilerlemesi orphan kalmaz.
7. Reviewer footnote/page_number/headers RSVP/TTS'de yok ama normal reader'da erişilebilir; poetry/quote semantik bozulmaz.
8. Audio missing/corrupt segment yükleme bloklar ve player hata yönetimi.
9. Arka plan audio lock screen, sleep timer, hız, kulaklık/Bluetooth odak kaybı.
10. Uzun başlık, sıfır bölümlü bozuk kitap, iki kolonlu PDF, scanner PDF, DRM: güvenli reddetme.

## First implemented semantic revision storage
The foundational tables and immutable-source tests for #13 are documented in `docs/14-IMMUTABLE-CONTENT.md`. Source text is persisted verbatim with SHA-256 and stable block IDs, while footnote/page number/running header/publisher note blocks can be excluded from RSVP/audio without deletion. This does **not** imply that the complete reading, language switch, audio cursor, or offline sync system is implemented.

## Implemented preliminary translation anchors
`docs/16-TRANSLATION-ALIGNMENTS.md` describes verified revision-qualified 1:N/N:1 paragraph mapping and explicit chapter-only fallback when not verified. No word offset is copied between languages. The real reader/UI/cursor persistence remain issue #36 work.

## MVP implementation #36

See [71-MVP-READING-POSITION.md](71-MVP-READING-POSITION.md) for the implemented verified-owner position API, CAS version and explicit web restore/save. The full cross-device offline design above remains future work.
