# Folio | Yeni Sohbete Devir ve MVP Duraklatma Kaydı

> **DURUM: GELİŞTİRMEYE ARA VERİLDİ.** Kullanıcı 13 Ekim 2026'da ilerlemenin kalıcı kaydedilmesini ve bir süre durulmasını istedi. Bu belge bir **anlık devir fotoğrafıdır**; yeni sohbet başladığında GitHub'daki gerçek durum yeniden doğrulanmalıdır. Herhangi bir sürekli arka plan geliştirmesi, otomasyon veya production deploy bu kayıttan doğmaz.

## 1. Temel bağlantılar ve kaynak önceliği

- Repo: https://github.com/VOX-Medya/folio
- Kapsam kararı ve aynı tarihli kalıcı checkpoint yorumu: [issue #170](https://github.com/VOX-Medya/folio/issues/170)
- MVP kapsam ve yürütme planı: [docs/62-MVP-EXECUTION-PLAN.md](62-MVP-EXECUTION-PLAN.md)
- Proje talimatları: [docs/63-MVP-PROJECT-INSTRUCTIONS.md](63-MVP-PROJECT-INSTRUCTIONS.md)
- CI: [ci.yml](../.github/workflows/ci.yml)
- Son doğrulanan `main`: [ea59c82361a68ef2cd525012b4246a8a225dc499](https://github.com/VOX-Medya/folio/commit/ea59c82361a68ef2cd525012b4246a8a225dc499) (PR #189 squash merge).

GitHub Issues, PR ve Actions **canlı durum için nihai kaynaktır**. Bu sayfanın yüzdelerini veya `main` SHA'sını yeni oturumda otomatik olarak güncel varsayma.

## 2. 13 Ekim 2026 | Dondurulan ilerleme

Geçerli görevler `scope:v1` + `type:task`, yalnız `state=closed` ve `state_reason=completed` olanlar tamamdır. #27 ve #28 `duplicate` olarak kapatılmıştır, **paydanın dışında** tutulur. 31 etiketli issue'dan 29'u geçerli; 27 tamam, 2 açık.

| Faz | Tamamlanan / Toplam | Durum |
| --- | ---: | ---: |
| V1-00 Temel Mimari | 5 / 5 | %100,0 |
| V1-01 Katalog ve Admin | 9 / 9 | %100,0 |
| V1-02 Expo ve Okuyucu | 7 / 8 | %87,5 |
| V1-03 Gizlilik, Arkadaşlık, Roller | 3 / 3 | %100,0 |
| V1-04 Test ve Yayın | 3 / 4 | %75,0 |
| **GENEL MVP/V1** | **27 / 29** | **%93,1** |

**Aktif faz: V1-02.** Duraklatma anında **açık PR yok**. Son birleşen PR'lar [#188 arkadaşlık](https://github.com/VOX-Medya/folio/pull/188) ve [#189 izole geri yükleme](https://github.com/VOX-Medya/folio/pull/189).

## 3. Çalışan MVP kapsamı (geliştirme/test kabulü)

- NestJS modüler monolit, PostgreSQL + Drizzle migration, pg-boss, sözleşmeler ve daraltılmış GitHub Actions CI.
- Yazar/eser/baskı, bölüm ve immutable bloklar, ülke/telif görünürlük kapıları, inceleme → yayın/geri çekme, minimum admin ve roller.
- Onaylı hazırlanmış kaynaklar için sürümlü manifest, SHA-256 ve `folioctl` CLI `dry-run/apply`; özel kaynağa owner/SHA korumalı erişim.
- Expo Web TR/EN duyarlı kabuk, kitap/yazar arama, raf, normal okuyucu, RSVP WPM ve kelime grubu, **hazır** ses oynatma ve kullanıcıya özel kalıcı okuma konumu.
- Gizli varsayılan profil ve veri silme **talep kaydı** (gerçek veriyi silme değil), davet kodu ile karşılıklı arkadaşlık, daveti kabul/ret ve engelleme.
- Sentetik GitHub-hosted gerçek Chrome → Nest HTTPS → ayrı Folio-only PostgreSQL olumlu/negatif akışları; şifreli gerçek production yedeği **değil**, izole sentetik veritabanı + özel dosya restore smoke.

**Sınır:** Bu kabul, native cihaz, mağaza imzalama, gerçek telif onayı, production hosting veya canlı kullanıcı kabulü değildir. Başlangıçta 1.000 kitap zorunlu değil; küçük, hakları onaylı katalog yeterlidir.

## 4. Açık iki MVP görevi / engeller

**[#30 Kullanıcı girişi, güvenli oturum ve onboarding](https://github.com/VOX-Medya/folio/issues/30) — AÇIK**

- [PR #186](https://github.com/VOX-Medya/folio/pull/186) ve [Actions #38166168494](https://github.com/VOX-Medya/folio/actions/runs/38166168494) başarılı: sentetik doğrulanmış hesapla login/logout, Secure HttpOnly cookie, CSRF, session, onboarding, 401/403/404 negatif yollar.
- **Eksik:** herkese açık gerçek self-signup, e-posta doğrulama mesajının yetkili taşıyıcı üzerinden güvenle gönderilmesi ve gereken native oturum kabulü. DB'deki `registerPendingAccount`/`verifyAccountEmail` iç primitive'leri gerçek e-posta teslimi değildir; challenge/token HTTP'ye veya loga sızdırılmaz.
- SMTP/e-posta hizmeti, gönderici alan adı, production secret ve hukuki veri onayları insana bağlıdır. Dış bağımlılığı beklerken gereksiz üretim altyapısı açma.

**[#48 Production yayın ve güvenlik kabul kapısı](https://github.com/VOX-Medya/folio/issues/48) — AÇIK / `status:blocked`**

- Gerçek telif ve ülke hak onayları; kullanıcı/hesap veri saklama-silme hukuku; production servis/secret, e-posta taşıyıcı ve alan adı; Apple/Android mağaza, signing ve gerçek cihaz testi; şifreli offsite backup/rollback sorumluluğu; güncel dependency release audit; insanın açık yayın onayı.
- Daha önce bilinen bağımlılık güvenlik bulgularını **çözülmüş veya bugünkü sayıları doğrulanmış olarak gösterme**; release öncesi yeniden denetle.
- Gerçek kullanıcı verisine dokunma; production build/deploy ve geri dönüşü olmayan canlı değişiklikleri açık insan onayı olmadan yapma.

## 5. Kanıtlı CI ve durum doğrulama sınırı

| PR / kanıt | GitHub Actions | Son doğrulanan durum |
| --- | --- | --- |
| #186 login/session | [38166168494](https://github.com/VOX-Medya/folio/actions/runs/38166168494) | `check` SUCCESS, `full-regression` SUCCESS |
| #188 davet kodlu arkadaşlık | [38171420225](https://github.com/VOX-Medya/folio/actions/runs/38171420225) | `check` SUCCESS, `full-regression` SUCCESS |
| #189 sentetik backup/restore | [38171764331](https://github.com/VOX-Medya/folio/actions/runs/38171764331) | `check` SUCCESS, `full-regression` SUCCESS |

GitHub connector `fetch_commit_workflow_runs` yalnız PR olaylarını aradığı için son `main` push CI sonucu o API ile **bağımsız doğrulanamadı**. Yeşil PR testini yeni `main` koşumu olarak anlatma.

Normal PR: hızlı `check`. DB/auth/dosya/haklar değişikliğinde `ci:full` ile gerçek izole PostgreSQL/HTTPS ve kritik browser testi. `main`: tek `full-regression`. `extended` elle gerektiğinde. GitHub-hosted Ubuntu Actions tek otomatik geliştirme/test ortamıdır; Desktop Commander, kullanıcı bilgisayarı, SSH veya farklı remote makine kullanılmaz.

## 6. Kullanıcı devam etmek istediğinde uygulanacak tek başlangıç sırası

1. **Yalnız yeni talep geldiğinde devam et.** GitHub `main`, açık PR'lar, son CI, #30 ve #48, `scope:v1 + type:task` etiket/issue `state_reason` durumlarını yeniden sorgula. Geçmiş `27/29` anlık görüntüsünü varsayma.
2. Bağımlılığı çözülmemiş #30 içindeki public signup + güvenli doğrulama teslim kodunu küçük çalışan dikey parça olarak ele al; gerçek e-posta sağlayıcı/alan adı/secrets gereksinimini #48'de `blocked` tut. Doğrulama challenge'ını client'a vermek gibi bypass yapma.
3. Sadece gerçek kabul kanıtıyla PR aç/CI doğrula/merge et/issue kapat. #48 insan onayı gerektirdiği sürece açık kalır. Üretim için dış hizmet/cihaz/hukuk sorumlulukları ayrı listelenir, çalıştırılmış gibi sayılmaz.
4. Runtime MFA/RBAC/CSRF, owner/private asset, SHA-256, telif/territory ve güvenli yayını azaltma. Eski AFTER-MVP issue'ları #15, #17, #20, #22, #24, #25, #37, #38, #41, #42, #44 kapsam dışıdır; yeni gereksiz PR/test matrisi/servis ekleme.
5. Her kullanıcı yanıtının **en sonunda bir defa** 5 faz, genel MVP yüzdesi ve aktif fazı son GitHub durumuna göre göster. Tamamlanan sayısı ancak `closed/completed` kabul kanıtıyla artar.

**Duraklatma kaydı yeni işi tamamlamaz, production onayı sağlamaz, otomatik arka plan geliştirmesi başlatmaz.**
