# Folio MVP | GitHub Issue yürütme haritası

Karar: [#170](https://github.com/VOX-Medya/folio/issues/170). Kabul ve kritik sıra: [docs/62-MVP-EXECUTION-PLAN.md](62-MVP-EXECUTION-PLAN.md). Uzun açıklamaları tekrar etmek yerine bu kısa haritayı kullan.

| Faz | MVP görevleri | En yakın çıktı |
| --- | --- | --- |
| V1-00 (5) | #7 #8 #9 #10 #11 | CI/monorepo, tasarım tokenı, Nest, DB/jobs, test lab |
| V1-01 (9) | #12 #13 #14 #16 #18 #19 #21 #23 #26 | eser→bölüm→hak→manifest/import→minimal admin/ses |
| V1-02 (8) | #29 #30 #31 #32 #33 #34 #35 #36 | gerçek Expo Web katalog→okuyucu/RSVP/ses→konum |
| V1-03 (3) | #39 #40 #43 | gizlilik, kodla arkadaş daveti, rol/audit |
| V1-04 (4) | #45 #46 #47 #48 | az sayıda gerçek uçtan uca smoke, negatif auth/private, backup, release |
| **MVP toplam** | **29 geçerli task, başlangıçta 4 completed** | **tek çalışan ürüne doğru** |

**Kritik bağımlılık:** #7'nin geliştirme CI kabulü (advisory release kararı #48) → #12 → #13/#14 → #18/#19 + #26 → #21/#23/#16 → #29/#30/#31/#32/#33/#34/#35/#36 → #39/#40/#43 → #45/#46/#47/#48. Tam bağımlı olmayan veri, UI ve mobil işler paralel ilerleyebilir. Bitmemiş edge-case, izinli kullanıcı akışını engellemiyorsa ayrı AFTER-MVP notudur.

**AFTER-MVP (11):** #15 #17 #20 #22 #24 #25 #37 #38 #41 #42 #44. GitHub milestone tarihsel V1 numarasıyla kalsa bile `scope:future` etiketi yüzdesel hesap dışında tutar. Mükerrer #27/#28 paydada değildir.

**Diğer AFTER-V1 işler (değişmedi):** #49–#62, dış kaynak entegrasyonu, AI üretim, GPU, ödeme, kulüp/DM ve ölçek işleri.

**Yürütme:** GitHub API ile kod/issue/PR; test yalnız GitHub Actions Ubuntu. Her PR bir issue dikey teslimi; normal PR hızlı test, `ci:full` işlev/DB/auth/rights değişikliğine, `extended` manuel özel incelemeye. Gecelik tam tekrar yok. `main`de tek MVP smoke. İnsan onayını #48'e ertele, canlı deploy yok.

**Tek bitirme kuralı:** İşlevsel API/UI veya CLI + ilgili küçük test + gerçek CI URL. Uygun olmayan browser/native/release matrisi tüm issue'ların kapanış bağımlılığı değildir. Hak/özel kullanıcı veri sınırları ve production onay kapısı her durumda korunur.
