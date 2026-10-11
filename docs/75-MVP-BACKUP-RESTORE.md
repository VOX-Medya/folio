# #47 | İzole Folio PostgreSQL ve özel varlık geri yükleme

Durum: Bu belge ve `infra/backup-restore-smoke.sh` tek başına tamamlanma kanıtı değildir; tam GitHub Actions `ci:full` + `ci:backup` sonucuyla doğrulanır.

## Geliştirme kabul yolu

Folio-only GitHub-hosted Ubuntu runner içinde:

1. `bash infra/lab.sh db-up`, `migrate`, `test-db` ile yalnız sentetik `folio_test` hazırlanır. Bu ortam dışında script `GITHUB_ACTIONS=true`, `CI=true`, sabit `FOLIO_DB_PORT=55432` olmadan çalışmaz.
2. Bir sentetik `audit_events` kanıtı ve `folio_lab_private_assets` adlı özel hacimde SHA-256 doğrulanabilir sentetik canary hazırlanır. Gerçek kullanıcı/kitap/şifre kullanılmaz.
3. PostgreSQL `pg_dump --format=custom`, özel volume `tar` ile ayrı geçici dosyalara alınır; geçici dizin 0700 ve `umask 077`.
4. Yeni tek seferlik **ayrı**, portsuz `postgres:17-alpine` container + yeni iki Docker volume oluşturulur. `pg_restore` ve özel varlık tar geri yüklenir.
5. Restored veritabanında canary bir kez görünmeli; yeni private volume içindeki dosyanın SHA-256'sı kaynakla eşleşmelidir. Başarısız adımlar `exit 1` verir. Sentetik kaynak canary ve geçici container/volume/trap temizlenir; Folio test DB genel olarak sıfırlanmaz.

İlgili CI job yalnız etiketli PR (`ci:full` ve `ci:backup`) veya manuel `extended` profilinde çalışır. `main` günlük regression hattına yeni tekrar eklenmez.

## Production yayınından önce #48 açık

Bu, canlı yedeklerin varlığını, offsite güvenli kopyayı, depolama şifrelemesini, anahtar saklamayı, tutma politikasını, yetkili hesapları veya RPO/RTO sınırlarını **kanıtlamaz**. Operatör onayıyla production/offsite yedek altyapısı, secret ve gerçek felaket tatbikatı ayrıca #48 kapsamındadır. Geliştirmede Docker image build, gerçek veriler, live-domain deploy veya dış servis gerekmiyor.
