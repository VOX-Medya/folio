# GitHub Actions | Tek MVP geliştirme/test ortamı

Karar: [#170](https://github.com/VOX-Medya/folio/issues/170). **GitHub-hosted Ubuntu Actions** birincil ve tek yetkili otomatik kod test ortamıdır; kullanıcı Desktop Commander/mehmet, SSH, yerel terminal veya başka remote-runner servisine bağlanma. GitHub API ile issue→branch/PR ve CI sonuçları kullanılır. Actions ephemeral CI'dır, production backend/DB veya sürekli çalışan ajan değildir.

## CI çalışma matrisi

| Tetik | `check` | `full-regression` | ClamAV native |
| --- | --- | --- | --- |
| Normal PR | hızlı lint/TS/unit/OpenAPI | atlanır | atlanır |
| `ci:full` etiketli PR | hızlı kontrol | MVP DB/HTTPS/Chrome/Expo | atlanır |
| Push `main` | atlanır, tekrarlamaz | **bir** MVP regresyonu | atlanır |
| Manuel `validation=fast` | hızlı | atlanır | atlanır |
| Manuel `validation=full` (varsayılan) | atlanır | **bir** MVP regresyonu | atlanır |
| Manuel `validation=extended` | atlanır | MVP + ek smoke, visual, audit, non-deploy Docker | sentetik protokol |

`full-regression` gerçek ayrı `folio_test` PostgreSQL ve geçici HTTPS ile kritik catalog/content/rights/import/storage/auth/admin katalog akışlarını doğrular; `pnpm e2e` Chrome ve üç Expo JS hedefi çalışır. Native Android/iOS signing veya fiziksel cihaz testi **değildir**. Extended eski ek smoke komutlarını korur, her commit'te tekrar etmez. Folio-only Compose project/volume/networks; `down` volume silmez; `.env.lab` gitignored sentetik sırdır.

## Minimum kabul
1. Issue için **çalışan** API/UI/CLI akışı, gerekli migration/OpenAPI belgesi.
2. İlgili unit/contract ve kritik negatif örnek; riskli auth/DB/storage/rights PR'da `ci:full`. Tüm senaryolar ve her viewport/tema ayrı PR'da şart değildir.
3. GitHub Actions run URL, gerçek sonuç, issue referanslı PR; kabul sağlanınca completed. `main` yeşili tek başına tamamlanma veya production onayı değildir.

## Güvenlik sınırı
Geliştirme advisory uyarıları nonblocking. Registry `pnpm security:release-check` manual extended sırasında kayıt altına alınır; **production release** aşamasında #48'de bloklayıcıdır. Auth, admin MFA, RBAC/CSRF, private-owner, hash, MIME, kaynak provenance, telif/ülke hakkı ve yayın kapıları test için bile bypass edilmez. Gerçek kullanıcı/veritabanı, mağaza signing, prod build, canlı deploy yok. İnsan onayı gerektiğinde #48'e blok kaydı düş ve başka bağımsız V1 görevine devam et.
