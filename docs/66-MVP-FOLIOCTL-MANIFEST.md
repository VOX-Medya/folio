# #18 | Minimal Folio JSON manifest + `folioctl validate`

**Sürüm:** `schemaVersion: "1.0.0"`. Manifest, bir hazır eserin başlık/dil/yazar/baskı etiketini ve **yerel** kaynak varlıklarını açıklar. Her `files[]` satırı `path`, `kind` (`text`, `audio`, `cover`), `sha256` (64 küçük hex) ve `sizeBytes` içerir. Tek kitaplık MVP paketinde tam **bir** hazırlanmış metin (`kind:"text"`) zorunludur. `packageId` benzersiz RFC4122 v4 UUID'dir.

**Örnek:** `fixtures/folioctl/single-book/manifest.json`; sentetik `content/source.txt` verisi `abc` (3 byte, SHA-256 `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`).

```bash
pnpm folioctl validate fixtures/folioctl/single-book/manifest.json
```

Komut tüm dosyalar için mevcut gerçek byte sayısını ve SHA-256'yı hesaplar; yanlış SHA, eksik dosya, geçersiz JSON/sürüm, güvenli dizin dışına çıkan yol, symlink ve yinelenen dosya yolunu reddeder. Çıktıda paket/manifest kimliği ve doğrulanmış dosya sayısı vardır. Maksimum manifest 256 KiB, varlık başına 200 MiB, paket başına 50 varlık.

**Önemli:** `validate` salt okunurdur, veritabanına erişmez, hukuki hak veya yayın izni vermez, metni değiştirmez ve yayınlamaz. `dry-run`/`apply` ve idempotent DB importu #19'da geliştirilecek. #14 hak kapısı, #23 yayın ve #26 özel dosya sınırı geçilmeden kullanıcıya hiçbir metin açılmaz. OCR, AI ve otomatik indirme yoktur.

**GitHub Actions kabulü:** `tools/ci/folioctl.test.mjs` sentetik fixture pozitif + SHA/eksik dosya/symlink/path-scope negatiflerini `pnpm ci:contract-test` altında çalıştırır. Tüm geliştirme/test tek GitHub-hosted Ubuntu üzerindedir.
