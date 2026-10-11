# Folio MVP | Tek teslim hattı, issue kesiti ve kabul sözleşmesi

**Karar:** [#170](https://github.com/VOX-Medya/folio/issues/170), 11 Ekim 2026. Eski geniş V1 kapsamından **küçük, kullanılabilir e-kitap + RSVP + hazır ses** ilk sürüme inilir. GitHub issue geçmişi korunur. Bu belge `docs/00-PRODUCT-SCOPE.md` içindeki geniş V1 listesiyle çeliştiğinde **MVP uygulama sırası ve kabul kapsamı açısından** önceliklidir; hukuki/gizlilik/yayın kurallarını geçersiz kılmaz.

## MVP çıkış tanımı
- Expo tek kod: responsive Web/Android/iOS iskeleti; gerçek mobil mağaza sertifikasyonu ayrı #48.
- TR/EN UI, giriş/oturum, basit kullanıcı rafı, eser ve yazar arama, eser detay.
- Hakları doğrulanmış manuel hazırlanmış manifest+SHA-256 ile ilk kitapların CLI dry-run/apply; insan incelemesi → draft/yayın. İlk sürüm için **1.000 kitap şart değildir**; 1.000 kitap katalog genişletme hedefidir.
- Güvenli bölüm/metin okuyucu, RSVP WPM+grup, **önceden yüklenmiş** ses kaydı, sunucuda temel son konum. Çevrimdışı indirme/karmaşık çeviri hizalaması sonraya.
- Kullanıcı profili gizli varsayılan; basit karşılıklı davet kodlu arkadaşlık ve minimum admin rol/audit. Kullanıcı/arkadaş keşfi yok, arama yalnız kitap/yazar.
- En az bir gerçek browser→API→ayrı PostgreSQL olumlu/olumsuz kullanıcı akışı; güvenli özel asset erişimi ve yayın hak kapısı. Release yalnız manuel onaydan sonra.

## Geçerli MVP görev matrisi (29 görev)

| Faz | Dahil issue'lar | Görev | Tamamlanan (karar anı) |
| --- | --- | ---: | ---: |
| V1-00 Temel Mimari | #7, #8, #9, #10, #11 | 5 | 4 |
| V1-01 Katalog / Admin | #12, #13, #14, #16, #18, #19, #21, #23, #26 | 9 | 0 |
| V1-02 Expo / Okuyucu | #29, #30, #31, #32, #33, #34, #35, #36 | 8 | 0 |
| V1-03 Gizlilik / Arkadaşlık / Roller | #39, #40, #43 | 3 | 0 |
| V1-04 Test / Yayın | #45, #46, #47, #48 | 4 | 0 |
| **Toplam** | **scope:v1 + type:task, duplicate hariç** | **29** | **4** |

`scope:v1` + `type:task` olanlar gerçek payda; epic, duplicate, `scope:future` hariç. Sadece kabul maddeleri kanıtlı ve GitHub `closed/completed` olanlar paydır. Bu tabloda bulunan 4/29 = **%13,8** yalnız **başlangıç** görüntüsüdür, kalıcı değer değildir; her yanıtta GitHub'dan yeniden hesapla. Test sonucunu uydurup issue kapatma.

## AFTER-MVP'ye alınan mevcut işler (11)
`#15` tam TR/EN N:M çeviri hizalaması; `#17` özel deterministik kapak motoru (ilk sürümde basit Folio CSS/şablonu); `#20` kişisel EPUB/PDF parser/yükleme; `#22` yedi sekmeli gelişmiş admin/diff; `#24` import/export sihirbazı (CLI kullanılacak); `#25` gelişmiş manuel ses/çeviri/kapak editörü (önce CLI); `#37` not/vurgu/yer imi; `#38` offline indirme/kota; `#41` yorum/puan/akış; `#42` hedef/streak/analitik; `#44` uygulama içi bildirimler. Bu işler **silinmez**, `scope:future` olarak muhafaza edilir ve MVP kapanışını engellemez. Mevcut GitHub milestone numarası eski V1 içinde kalmış olabilir; scope etiketi ve bu karar geçerlidir.

## Tek kritik yol (sıralama, ayrı yeni servis yok)
1. **#7** sadece CI ve monorepo geliştirme kabulünü bitir; dependency **production** release bulguları **#48**'de kalır. Eski tamamlanmış #8–11 yeniden test gerektirmeden tamamlanmış kalır.
2. **#12 → #13 → #14 → #18 → #19 + #26**: gerçek yazar/eser ve immutable bölüm, basit telif/hak onayı, güvenilir CLI paket kontrolü, dry-run/apply/idempotent kayıt. Kaynak SHA ve özel varlık kontrolü kaldırılmaz. Çakışan başlık/ISBN otomatik merge yapılmaz; anlaşılmayan öğe **draft/needs-review** kalır, ilerleme diğer kitaplarda sürer. Çok editörlü kimlik çatışması defterleri için yeni PR yok.
3. **#21 + #23, #16**: minimal admin list/create/incele/yayın, hazır ses referansı. 7 sekme ve büyük editoryal dashboard şart değil.
4. **#29 → #30 → #31/#32 → #33/#34/#35 → #36**: Expo Web üzerinde gerçek son kullanıcı akışı; tablet/desktop reflow, TR/EN. Uygulamanın gerçek ses oynatabildiğini, RSVP'nin ilerlediğini ve konumun kalıcı olduğunu göster. Android/iOS native imzalar/cihaz sertifikasyonu #48.
5. **#39/#40/#43**: gizli profil, davet/karşılıklı kabul, mevcut admin RBAC minimum.
6. **#45/#46/#47/#48**: tek gerçek smoke hattı, 401/403/private asset ve yetki ihlali negatif testi, bir yedek+restore kanıtı, platform/izin/yayın onayı. Hukuki onay ve production secrets insana bağlıysa #48'e açık not bırak ve bağımsız göreve devam et.

## Daraltılmış kabul şablonu
MVP issue **üç koşulda** kapanabilir:
1. **Çalışan dikey özellik:** gerçek kod (mock ekran değil), geçerli payload/akış; tek modül veya uçtan uca birleşik kullanıcı yolu.
2. **Minimal regresyon:** ilgili unit/contract + tek kritik negatif senaryo (ör. 401/403/409 veya bozuk dosya); DB/izin/özel dosya değişikliğinde gerçek Folio-only PostgreSQL/HTTPS smoke. Gereksiz 6 ekran çarpı 2 dil çarpı 2 tema matrisi **her PR'da aranmaz**.
3. **Kanıt ve bütünlük:** GitHub Actions bağlantısı, ilgili OpenAPI/migration belgesi gerekiyorsa güncelleme; kaynak/telif/owner gizliliği bozulmaz, test verisi sentetiktir. Tek issue'nın kabulü için alakasız tamamlanmamış sosyal, native cihaz, offline veya diğer V1 işleri bağımlılık yapılmaz.

## CI ve ortam
- **Tek otomatik çalışma ortamı: GitHub-hosted Ubuntu Actions.** Desktop Commander, SSH remote desktop, kullanıcının bilgisayarı kullanılmaz.
- Normal PR: tek hızlı `check` (lint, TS, unit, OpenAPI); `main`: bir `full-regression` (Folio-only DB+kritik API smoke+Chrome+Expo JS). Hassas PR isteğe bağlı `ci:full`; manuel `fast`/`full`/`extended`.
- Gece baştan tüm testleri çalıştırma, sentetik ClamAV apt kur, non-deploy Docker, tüm negatif corpus, 6 ekran görüntüsü ve registry audit **her commit'te tekrar edilmez**; elle `extended` komutuyla ihtiyaca göre.
- Advisory ve dev bağımlılık bulguları **geliştirmeyi engellemez**; bağımsız `pnpm security:release-check` başarısız ise **production release #48 blocked** kalır. Auth/MFA/RBAC/CSRF, sahte veri, özel dosya, hak kanıtı ve checksum hiçbir modda atlanmaz.
- GitHub Actions bir kalıcı uygulama sunucusu değildir; production altyapı açık onaya bağlıdır. Gerçek APK/AAB/IPA, mağaza ve insan hak incelemesi ayrıca planlanır.

## Açık kararlar ve eskalasyon
- Kullanıcı onayı / telif / signing key / gizli ortam bilgisi gerektiren işi issue #48'de bloke, açık ve tamamlanmamış olarak kaydet; başka bağımsız geliştirmeye geç. **İnsan yanıtını beklemek için development durmaz.**
- Yalnız kişisel veri güvenliğini tehlikeye atan veya geri döndürülemez canlı işlem zorunluysa dur ve onay iste.
- Eklenecek her ekstra mekanizma için önce şu soruyu sor: **MVP'nin çalışan okuyucu akışını bugün engelliyor mu?** Hayırsa yeni API/protokol/review kuyruğu değil, AFTER-MVP notu.
