# Folio | Minimal CI / pahalı kontrollerin seçime bağlı yürütülmesi

**Geçerli karar:** [#170](https://github.com/VOX-Medya/folio/issues/170). Ana workflow: `.github/workflows/ci.yml`. Geliştirme yalnız GitHub-hosted Ubuntu Actions üzerinde; kullanıcı Desktop Commander ve özel remote host kullanılmaz.

**Sebepler:** Eski akış `main` push'unda hem hızlı job hem `pnpm check` tam job'u tekrar çalıştırıyor, aynı içeriği her gece yeniden test ediyor, gereksiz ClamAV apt kurulumu ve Docker derlemesi ile pahalı tam doğrulamayı her değişikliğe bağlıyordu. Bunlar MVP üretim kodunu bitirmediği halde CI çevrimini uzattı.

**Yeni kural:** PR hızlı `check`; değişen yetki/DB/asset/import için `ci:full`; `main` push'unda **yalnız tek** MVP full regresyon. Gece tekrarı yok. Manuel `fast`, `full`, `extended`: sonuncusu ayrıca eski derin smoke, 6 katalog görsel örneği, lisans, kontrat negatifleri, native sentetik ClamAV, Docker (dağıtımsız) ve bağımlılık audit bilgisi toplar. Bu eski testler **silinmedi**, yalnızca per-commit engel olmaktan çıktı.

`pnpm check` tamamı main/manual full'da çalışır; `ci:full` PR'da hızlı check zaten ayrı job'da olduğundan regresyon job'u yeniden tüm unit/lint çalıştırmak yerine yalnız build + gerçek DB/HTTPS/E2E yapar. Her iki işin kendi izole checkout/install işlemi normaldir; güvenlik kanıtı olmayan sahte success üretilmez.

**Sınır:** Bu yalnız geliştirme test politikasıdır. Temel oturum/RBAC/MFA/CSRF, source/hash/malware quarantine, private dosya izolasyonu, ülke/telif/yayın kontrolleri devre dışı bırakılamaz. Bilinen dependency advisories nonblocking develop raporu olabilir, production için #48 **blocked** devam eder. İmzalı production build, native cihaz testi, canlı dağıtım ve backup/restore kabulü ayrı açık onaya bağlıdır. PR yeşili release onayı değildir.
