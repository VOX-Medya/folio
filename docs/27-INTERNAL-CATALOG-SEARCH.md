# #12 İç yönetim kataloğu arama sözleşmesi (kısmi)

Yazar ve eser araması V1 kapsamındadır. **Kullanıcı adı/kişi/arkadaş araması kesinlikle bu servise dahil değildir.**

`packages/db/src/catalog-search.ts` iki PostgreSQL sorgusu tanımlar:

- `searchCanonicalWorksForAdmin`: kanonik özgün başlıklar, `work_titles` içindeki alternatif/TR-EN çeviri başlıkları, kanonik yazarlar, yazar takma adları ve baskıların çevirmen/katkı verenleri üzerinden eserleri bulur. Aynı başlığa sahip farklı eserler veya aynı ISBN'e sahip farklı baskılar **otomatik olarak birleştirilmez**.
- `searchCanonicalAuthorsForAdmin`: `authors` ve `author_aliases` üzerinden yazarları arar. Kullanıcı profil/oturum/sosyal kayıtlarına erişmez.

Girdi boş olamaz ve 120 karakterle sınırlıdır. Limit 1–50; indekslenmiş UUID bazlı deterministik cursor ile sayfalama yapılır. SQL sorguları parametreli, `%`, `_` ve ters bölü karakterleri literal escape edilmiştir. `packages/db/scripts/catalog-smoke.ts` izole `folio_test` üzerinde UUID cursor, uzunluk reddi, alternatif başlık, yazar takma adı, baskı çevirmeni ve SQL LIKE wildcard kaçışını test eder.

**Önemli güvenlik sınırı:** Bu fonksiyonlar **yalnız iç yönetim servisi** içindir. Üst NestJS modülüne ya da public HTTP rotasına henüz bağlanmamıştır; gerçek admin session/RBAC (#30/#43) ve yayınlanmış eser/ülke/telif kapısı (#14/#23) eksikken taslak eserlerin kamusal aramada gösterilmesi yasaktır. Doğrulanmış ürün kataloğunun kamuya açık aranması için ilave hak filtrelemesi ve private kitap izolasyonu gerekir.

#12'nin bütün kabul kriterleri, gerçek Admin CRUD + arama UI, auth negatif testleri, audit ve cihaz/boyut E2E tamamlanıncaya kadar **OPEN** kalır.
