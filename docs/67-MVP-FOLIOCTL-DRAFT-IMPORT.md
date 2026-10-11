# #19 | Tek kitap icin CLI dry-run / apply

Bu ilk MVP yolu hazirlanmis **tek UTF-8 metni** (`kind: "text"`, en cok 1 MiB) yazar/eser/baski, kaynak revizyonu ve normal/RSVP metin blogu olarak **draft** halinde ekler. Manifest girdi formati: [#18](66-MVP-FOLIOCTL-MANIFEST.md). Haklari onaylamaz, yayimlamaz, kullanici dosyasi yuklemez; ses/kapak paketi #16/#26 islerine kadar `apply` tarafindan reddedilir.

## GitHub Actions / izole Folio ortami

```bash
pnpm --filter @folio/contracts build
pnpm --filter @folio/db build
# GitHub Actions Folio-only PostgreSQL folio_test / folio_lab
export DATABASE_URL="postgresql://folio_lab:<local-secret>@127.0.0.1:55432/folio_test"
pnpm folioctl validate fixtures/folioctl/single-book/manifest.json
pnpm folioctl dry-run fixtures/folioctl/single-book/manifest.json
# Apply icin sadece yetkili, guncel MFA'li superadmin oturumu; bearer loglanmaz.
export FOLIO_ADMIN_BEARER="<ephemeral-admin-session>"
export FOLIO_PRIVATE_STORAGE_ROOT="<absolute-private-0700-directory>"
pnpm folioctl apply fixtures/folioctl/single-book/manifest.json
```

Bu komutlar sadece acikça belirtilmis `localhost/127.0.0.1`, ayrilmis `folio_test` veya `folio_lab` veritabanina baglanir. Canli sunucuya baglanmaz, production release yapmaz.

## Guvenlik / idempotency

- `dry-run`: PostgreSQL `READ ONLY` transaction; paket ve mevcut kimlik cakismasi raporu. Import/audit/medya satiri yazmaz.
- `apply`: `import:apply` yetkisi, gecerli email + session + ayni cihaz MFA + rol dogrulamasi tek DB transaction icinde; yetkisiz cagri yazamaz.
- Gercek byte SHA-256/boyut iki kez denetlenir. Metin `LocalStorageAdapter` ile `catalog` kapsaminda 0600 gizli karantinaya kaydedilir; veritabaninda `media_assets.pending_verify`, `content_revisions.draft`, `works.draft`, `editions.draft` bulunur. Okuyucuya acilmis varlik/yayin yoktur.
- Paket UUID + manifest checksum, `import_batches` ve `import_items` uzerinde korunur. Ayni paket/saglam manifest ikinci kez `noop`; degistirilmis checksum, baslik/yazar/kaynak cakismasi insan incelemesi icin `conflict`. Baslik/ISBN uzerinden otomatik birlestirme yoktur.
- Yetkisiz `--owner`, `rights`, `reviewStatus` ve benzeri ek manifest alanlari reddedilir. Hak kaydi olusturulmaz, `published` alani yazilmaz; manuel hak incelemesi/yayin ancak #14/#23 ile.
- Katologdaki kayitlar, onayli haklar ve kalici public asset sunumu sonraki ayri yayin karari olmadan degismez. Dosya yazimi DB commit'inden once private karantinadadir; rollback sirasinda kalabilecek sahipsiz karantina dosyasi public olarak servis edilmez.

## Kabul kaniti

`pnpm --filter @folio/db db:import-smoke` mevcut metadata import regresyonuna ek olarak gercek `folioctl` komutlariyla `folio_test` uzerinde dry-run, yetkisiz apply ret, 1 taslak eser+bolum+blok+asset, tekrar apply ve bozuk SHA/paket kimligi ret senaryolarini calistirir. PR `ci:full` sonucu dogrulanmadan #19 tamamlanmis sayilmaz.

Gelecek: Ayrica hazir ses baglama #16, medya dogrulama #26, manuel draft→yayim #23.