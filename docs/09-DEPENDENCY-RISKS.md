# Bağımlılık ve lisans incelemesi (#7)

10 Ekim 2026: Önceki Ubuntu `mehmet` laboratuvarında ilk pnpm audit sonucu 16 bulgu (2 critical, 6 high, 8 moderate). Sonraki doğrulanmış GitHub-hosted Ubuntu `main` CI kayıtlarında **4 high + 5 moderate** bulunuyordu. Metro 0.83.8 uyumluluk düzeltmesinden sonra [CI #38038050331](https://github.com/VOX-Medya/folio/actions/runs/38038050331) audit sonucunda **2 high + 5 moderate** kaldı. Bu tabloda ilk keşfedilen HIGH zincirleri ve mevcut çözüm durumu gösterilir:

| Paket | Güvenlik kaydı | Transitive zincir | Durum |
|---|---|---|---|
| image-size | GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr | expo / metro / image-size | **ÇÖZÜLDÜ (yalnız bağımlılık ağacı):** Metro 0.83.8 içinde vendor parser kullanılıyor; image-size lockfile'dan kaldırıldı ve JS export doğrulandı. Gerçek native cihaz testi bekliyor. |
| node-forge | GHSA-86w9-cpqp-85rv | expo / @expo/cli | Audit içinde yama sürümü belirtilmiyor; upstream takip edilecek |
| braces | GHSA-vfj7-8cjw-p6xm | expo / metro-file-map / micromatch | Audit içinde yama sürümü belirtilmiyor; upstream takip edilecek |

Yukarıdaki bulgular bir güvenlik onayı DEĞİLDİR. Yerel V1 prototip CI'sında yüksek önem taraması **uyarı olarak raporlanır ve bloklamaz** (aşağıdaki kullanıcı istisnası); eksik/kabul edilmemiş lisanslar ise hâlâ bloklar. Prod/gerçek kullanıcıya çıkışta audit bulguları çözümlenmeden yayın kapısı açılamaz. CDN/uzak kullanıcı dosyası, üretim içerikleri, token veya gerçek veri ile test yapılmadı. Gelecekte uygun upstream düzeltmeleri doğrulandıktan sonra tarama yeniden çalıştırılacaktır. `pnpm audit` çıktıları Ubuntu `/tmp/folio-audit-new.log` içinde saklandı. Kaynakta `node-forge` çoklu lisans bildirimi BSD-3-Clause seçimiyle, `MPL-2.0` içeren bağımlılıkların dağıtım bildirimleri sonraki yayın kontrolünde ayrıca doğrulanmalıdır.

### Uyum denemesi
Yamalı `image-size@2.0.4` geçici dependency override ile 10 Ekim'de denendi. Expo Web Metro export `TypeError: The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView` hatasıyla durdu. Uyumsuz major override geri alındı ve Expo Web tekrar başarıyla export edildi. Güvenlik bulguları sessizce yok sayılmayacak.

## Yerel geliştirme istisnası (10 Ekim 2026)
Kullanıcı talebiyle prototip geliştirmede bağımlılık audit çıktısı **görünür fakat CI'yı bloklamayan** kontrol olarak çalışır (`continue-on-error`). Bu bir zafiyet çözümü veya güvenlik onayı değildir. Canlı dağıtım, kullanıcı verisi, yayın hakkı ve gizlilik kapıları bu istisnaya dahil değildir. Yayın CI'sında audit tekrar zorunlu bloklayıcı olacaktır; #7 ilgili güvenlik kabul kriteri karşılanana kadar açık kalır.

## JS hedefleri ve doğrulama (10 Ekim 2026)
`pnpm mobile:export`, Expo'nun `--platform all` komutuyla Web JS, Android Hermes ve iOS Hermes bundle'larını yerelde üretir, `tools/ci/check-expo-exports.mjs` her bir hedefin çıktısını doğrular. Bu **Android APK/AAB, iOS IPA, Xcode build veya gerçek cihaz/simülatör testi değildir**. Ubuntu'da Xcode bulunmadığından iOS-native testleri yayına doğru dış ortamda yapılacaktır. `pnpm ci:contract-test` eksik platform durumunda denetleyicinin fail-closed olduğunu sınar. Lisans taraması `pnpm licenses list --json` ve `tools/security/check-licenses.mjs` ile bağımsız bloklayıcı olarak sürer.

## Metro 0.83.8 yaması: gerçek CI kanıtı (PR #101, 10 Ekim 2026)

**Sorunun nedeni:** `@expo/metro@54.2.0` Expo SDK 54 içinde 14 Metro alt paketini doğrudan `0.83.3` olarak kilitliyordu. `metro@0.83.3`, `image-size@1.2.1` kullanıyordu ve iki HIGH parser denial-of-service advisory'si taşıyordu. Major `image-size@2.0.4` override önceki denemede Web bundle'ı bozduğu için tekrar uygulanmadı.

**Düzeltme:** Kök `package.json` içindeki `pnpm.overrides` ile 14 Metro paketi **aynı 0.83.8 patch sürümüne** taşındı. `pnpm-lock.yaml`, sentetik GitHub Actions Ubuntu branch workflow ile yeniden üretildi. Sadece bu iş için oluşturulmuş write-permission workflow'u, PR açılmadan önce branch'ten **silindi**. Metro 0.83.8; `image-size` paketini dependency listesinden kaldırıp tanıdığı görüntü biçimleri için sınırlı yerel parser kullanır ([Metro 0.83.8 sürüm notu](https://github.com/facebook/metro/releases/tag/v0.83.8)). Artık lockfile'da `image-size@` ve `metro*@0.83.3` yok; tüm 14 paket 0.83.8.

**Geri dönüş engeli:** `tools/security/check-metro-graph.mjs`, `pnpm check` içinde çalışır ve 14 tam patch override'ı, tek sürüm çözümlemesini ve `image-size` paketinin yeniden girmemesini zorunlu tutar. `tools/security/check-metro-graph.test.mjs` negatif senaryolarda geri dönüşü fail-closed doğrular. Bu denetim diğer advisories için bir audit alternatifi DEĞİLDİR.

**Doğrulama:** [PR #101 CI #38038050331](https://github.com/VOX-Medya/folio/actions/runs/38038050331): `pnpm install --frozen-lockfile`, lint, TypeScript, unit, OpenAPI, yeni Metro guard, izole Folio PostgreSQL smoke'ları, Expo Web + Android/iOS Hermes JavaScript export, paket lisansı, Playwright Chrome **28/28** ve yerel Docker image build başarıyla geçti. Herhangi bir prod deployment yapılmadı. Bunlar gerçek Android APK/AAB, iOS IPA, iOS simulator, cihazdaki native çalışma ve `expo start` dev-server uyumluluğu testi **değildir**; gelecekte doğrulanmalı.

**Kalan güvenlik engelleri:** Aynı CI'da `pnpm audit` komutu **2 HIGH + 5 MODERATE**, exit 1 döndü; geliştirme için `continue-on-error` nedeniyle GitHub job sonucu yeşildir. İki HIGH: `node-forge@1.4.0` / [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) ve `braces@3.0.3` / [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). 10 Ekim 2026 tarihinde GitHub advisories üzerinde her ikisi için de yayımlanmış patched version yok. Başlıkları değiştirmek veya advisory ignore eklemek çözüm değildir. Uygun upstream upgrade, reachability azaltma ve native test kabulü tamamlanmadan **#7 blocked/açık, üretim güvenlik kapısı kapalı**.

## Security improvements without waivers (10 October 2026, #7 partial)

Real GitHub-hosted Ubuntu `pnpm why -r` and registry audit in [diagnostic #38066064739](https://github.com/VOX-Medya/folio/actions/runs/38066064739) resolved precise parents for all residual advisories. `node-forge` is installed by `@expo/cli`, `braces` by `micromatch` used throughout React Native/Metro/ESLint. The two HIGH upstream advisories list **no patched versions**. Five MODERATE advisory packages are `esbuild@0.18.20`, `js-yaml@5.3.0`, `uuid@7.0.3`, `decode-uri-component@0.2.2` and `sprintf-js@1.0.3`.

A minimal pnpm hardening experiment removes the `@esbuild-kit/esm-loader` edge from `drizzle-kit@0.31.11` and pins only `js-yaml@5.3.0` to patched `5.4.1`. The `pnpm-lock.yaml` regeneration was produced in an isolated branch-specific Ubuntu job whose write-enabled workflow erased itself. Preliminary `pnpm audit` **decreased from 2 HIGH + 5 MODERATE to 2 HIGH + 3 MODERATE**; `drizzle-kit --version` and 14 Metro override checks passed. Full frozen-lockfile, Drizzle migrations, unit, integration, Expo JS Web/Android/iOS and browser CI evidence will be attached to the PR before merge; the production security gate remains **BLOCKED**, not green. This does not mean a native device was run or that either remaining HIGH was waived.
