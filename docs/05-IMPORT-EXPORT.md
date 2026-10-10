# Yerel kitap hazırlama ve toplu transfer sözleşmesi (V1)

## Kapsam
Kitap kaynaklarından canlı veri çekme değil; editörün başka araçlarla yerelde hazırladığı *mevcut* özgün metin, çeviri, ses, telif kanıtı, cover metadata ve eser bibliyografisini sisteme taşıma. Initial target 1.000 eser / 2.000 dil sürümü (telif+kalite kontrollerine bağlı). Ses mecburi değildir; eksik ses/çeviri sonradan ayrı batch ile tamamlanabilir.

## Paket
Dosya adı folio-batch-{date}-{uuid}.tar.zst; iç içe arşiv içeriği şema sürümüne göre JSON/NDJSON/JSONL. Veritabanı dump'ı değildir.

Yapı:
- manifest.json (schema_version, package_id uuid, created_at, source=local-editorial, scope=licensed-library, declared counts, source tool/version, signature optional, assets index ve checksum manifest)
- metadata/authors.ndjson (id, canonical_name, aliases, authority IDs)
- metadata/works.ndjson (id, titles, original_language, authors[], categories, description)
- metadata/editions.ndjson (id, work_id, locale, translator/contributors, publication info)
- metadata/revisions.ndjson (id, edition_id, language, source_rev_id, content hash, provenance, state)
- metadata/rights.ndjson (work/edition/rev scope; source_url; evidence, country, display/translation/audio/share flags, review state)
- texts/{revision_uuid}/blocks.jsonl (chapter IDs, ordinal, block UUID, kind, source_text, per-mode flags, original locator, alignment keys)
- alignments/{source_rev}-{target_rev}.jsonl (N:M links; verified/unverified)
- audio/{variant_uuid}/{chapter_or_segment_uuid}.m4a or .opus (codec, duration, text hash, chapter association, variant language/voice)
- assets/{sha256}.{ext} (hazır audio/resimler), sha256sums.txt (every included path).

## Kitap aşamaları ve kalıcı statü
- candidate, imported_draft, invalid, needs_rights_review, needs_content_review, approved, published, withdrawn, archived. Validasyon passed ≠ telif approved ≠ public published.
- Hak kaydı yayın bölgesini sınırlıyorsa territory restrict. Çeviri ve audio hakları ayrı kontrol.
- Düzgün hazırlanmış ses dosyası gelir; V1 otomatik ses üretim işi yaratmaz. Hazır çevirinin kaynağı, dil ve kaynak revizyonu gerekir; çeviri editör denetimi kaydı tutulur.

## Komut hedefleri (henüz tasarım, uygulanacak)
folioctl pack validate --input ./prepared-books
folioctl pack build --input ./prepared-books --out ./folio-batch.tar.zst
folioctl import ./folio-batch.tar.zst --dry-run --report ./validation.json
folioctl import ./folio-batch.tar.zst --apply
folioctl import --resume {batch_id}
folioctl import --status {batch_id}
folioctl export --scope licensed-library --out ./folio-export.tar.zst
folioctl export --work-id {uuid} --out ./folio-work.tar.zst

SSH yol:
scp ./folio-batch.tar.zst deploy@server:/srv/folio/imports/
ssh deploy@server 'folioctl import /srv/folio/imports/folio-batch.tar.zst --dry-run'
ssh deploy@server 'folioctl import /srv/folio/imports/folio-batch.tar.zst --apply'
Tüm gerçek host/credential değerleri secret/env'de; örnek hostname repo'ya konmaz.

## Import doğrulaması
1. Yanlış/missing schema_version, package_id, checksum, path traversal, symlinks, bomb decompress, mimetype spoof, max per-file/total size durumunda işlem kayıtsız reddedilir.
2. İçe alma planı staged tablolarda oluşturulur, dry-run hiçbir katalog kaydını değiştirmez. Rapor: create/update/noop/conflict/reject, eser/yazar eşleşmesi, hak eksikleri.
3. Unique package_id + import checksum ile idempotent tekrar, başarısız partide checkpoint/resume. Transaction sınırları ve partial asset staging clean-up tasarlanır.
4. UUID eserin asıl anahtarı; başlık/ISBN eşleşmesi belirsizse otomatik merge yok. Author many-to-many. Aynı roman farklı çevirileri ayrı revisions; identical source hash tekrar basım için reuse yalnız haklar uygunsa.
5. Yeni çeviri, mevcut edition'a ve source revision'a bağlanır; altyazı/language mapping; audio asset revision mevcut content hash ile eşleşmiyorsa publish blocked.
6. Kaynak metne hiçbir sessiz müdahale yok, diff+audit. İki farklı paket eski revizyonu overwrite edemez; yeni immutable revision oluşturur.
7. Publish ayrı doğrulanmış admin işlemi; toplu import "hepsini yayınla" yapmaz. Admin seçici bulk approve/publish mekanizmasıyla.
8. Public export kişisel kullanıcı dosyalarını, gizli tokenları, oturumları ve private notları ASLA içermez. Katalog export yerine DB ve blob restore backup değildir.
9. Import sonrasında metadata/assets/chapter counts/fallback cover ve language/audio availability test edilir. 25–50 eserlik batches ve büyük ses aktarımında resume/sha256.
10. Eksik ses/çeviri no-op allowed; web UI doğru 'Henüz mevcut değil' gösterir. Silinmiş ses segmenti güncellemesi versioned + playing clients pinned variant.

## Admin UX
- Import wizard: dosya seçimi ya da sunucudaki dosya, validation, dry-run preview, mapping conflicts, approval/rights gate, apply, progress, report/export.
- Export wizard: scope/work seçimi, metadata-only veya rights-approved library ve assets, checksum, süreli download.
- Bulk işlemlerde tahmini disk/asset sayısı ve kullanıcı deneyimine etkisi göster.
- CLI ve Admin aynı backend import engine'i; farklı davranış göstermemeli.
- Local original file ve prepared assets için on-disk staging/quarantine; public served asset yalnız approve sonrası.

## Ilk uygulanan CLI temeli (#18, 10 Ekim 2026)
`tools/folioctl` artik `pack validate --input DIR` ve `pack build --input DIR --out FILE.tar.zst` komutlarini yalniz yerel editor tarafindan hazirlanmis, **draft** kaynak klasorlerinde calistirir. `manifest-v1.schema.json` JSON Schema `schema_version=1.0.0`, UUID paket kimligi, yerel kaynak, dosya/SHA-256/byte indeksi, authors/works/editions/revisions ilan sayilari, elle kaydedilen rights evidence ve tur bilgisi ile birlikte surumlenir. Kod dosya-yol gecisi, gizli dizin, liste disi dosya, symlink, ozel dosya, bayt limitleri, degistirilmis dosya veya manifest, izin verilmeyen sema surumunu reddeder. Paket olusturma orijinal metin/dosyayi degistirmez; `sha256sums.txt` dahil deterministik tar+zstd uretir ve ayni klasorden bitwise ayni arşiv birim testinde dogrulandi.

**Kesin ayrim:** Bu V1-01 #18 icin yalniz `prepared-folder -> signed-by-hash archive` altyapisidir. `pack validate` su an **arşivden geri dogrulama veya güvenli açma yapmaz**; `import --dry-run/apply/resume` (#19) ve hak denetimli `export --scope/--work-id` (#18/#23) kasitli olarak aktif degildir. Tam arsiv dosyasi path/symlink/bomb sinirlari ve JSONL semantik blok referanslarinin dogrulanmasi tamamlanmadan #18 kapatilmayacaktir. Bu arşivler dogrudan public katalog yayini ya da kullaniciya ait private veri tasimasi icin kullanilmaz.


## Arşiv doğrulama ve semantik kontrolleri (10 Ekim 2026)
`folioctl pack validate --input FILE.tar.zst` artik arşivi diske cikarmadan zstd+tar akisi uzerinden isler. Her tar kaydi yol/tur/uzunluk ve toplam sisirilmis veri sinirindan gecer, symlink/hardlink/ozel dosya ve index disi kayit reddedilir. `sha256sums.txt`, manifest ve dosya hashlerini dogrular; dosyaya ait block `source_text` hash'i ayrica aynen UTF-8 olarak dogrulanir. Author-work, work-edition, edition-revision kimlikleri ve dilleri tutarli olmali; her yazar/eser/revizyonun gerekli baglari, blok sirasi ve yardimci bloklarin RSVP/ses disinda tutulmasi paket once denetlenir. Hazir import kaniti kendiliginden rights approval veya katalog yayini olmaz. Guvenli ve deterministik paket build mevcut dosyalari/symlinkleri ezmez. Paket iceriği diskte acilmaz; gerçek veri import, public export ve onay ayridir. Negatif/pozitif test senaryolari `tools/folioctl/src/*.test.mjs`, guncel sinirlar `docs/20-FOLIOCTL-MANIFEST-FOUNDATION.md` icindedir.
