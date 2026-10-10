# #30 Gerçek hesap kontrolü ile opt-in HTTPS web giriş/çıkış (kısmi)

## V1 kapalı başlayan modül

`POST /v1/auth/web/login`, `GET /v1/auth/web/csrf` ve `POST /v1/auth/web/logout` ana NestJS `AppModule` içine eklenmiştir, **ancak varsayılan davranışları 404'tür**. Sadece açık `FOLIO_WEB_AUTH_MODE=direct-tls-only` ayarıyla çalışabilirler. Bu *prod açma onayı değildir*: reverse proxy arkasında TLS uygulamanın kendisinde sonlanmıyorsa tüm akış 503 ile kapalı kalır. İstemcinin `X-Forwarded-Proto` başlığı asla güvenilir TLS kanıtı sayılmaz.

- Şifre denemelerinden **önce** gerçek socket TLS, exact HTTPS Origin, Fetch Metadata, eksik/yanlış CSRF HMAC secret, cookie/Authorization crossover ve katı body kontrol edilir. Login CSRF için aktif oturum olmadığından mevcut oturum cookie'si veya Authorization başlığıyla giriş reddedilir. E-posta ile IP üzerinden önce PostgreSQL'de atomik rate quota uygulanır: login 20/IP, 5/account/15 dk. Bunun için `FOLIO_AUTH_ABUSE_HMAC_KEY_HEX` kalıcı 32 bayt güvenli hex anahtardır; yoksa 503.
- Hesap için `signInVerifiedAccount` gerçek scrypt parola doğrulaması, e-posta doğrulaması, aktif hesap ve 8 cihaz üst sınırı kullanır. Yanlış parola, olmayan, pasif, e-postası doğrulanmamış veya cihaz limiti dolmuş hesap aynı genel HTTP 401 mesajını alır. Token yalnız `__Host-folio_session` Secure/HttpOnly/SameSite=Strict cookie içinde döner, JSON cevabı 204 boş gövdedir. Ham bearer loglanmaz, DB'ye sadece SHA-256 digest yazılır.
- `GET /csrf` geçerli web cookie için yalnız same-origin Fetch Metadata/Origin ile 204 + `X-Folio-CSRF` üretir. `POST /logout` doğrudan TLS, exact origin, valid bearer ve doğru CSRF header olmadan çalışmaz; yalnız mevcut cihazın tokenunu transaction ile revoke eder ve yalnız başarılı iptal sonrası cookie temizler. İptal edilmiş token tekrar geçerli değildir.
- Her yanıt no-store olarak değerlendirilir; sunucu tarafında HMAC key ve cihaz oturum kayıtları merkezi Folio PostgreSQL'dedir. Özel kitap verisi veya kişisel okuma ilerlemesi değiştirilmez.

## Ortam ayarları ve güven sınırı

`FOLIO_WEB_AUTH_MODE`, `FOLIO_WEB_AUTH_ORIGIN` (tam HTTPS origin, ör. `https://reader.example.org`), `FOLIO_WEB_CSRF_KEY_HEX` (64 hex) ve `FOLIO_AUTH_ABUSE_HMAC_KEY_HEX` (64 hex) **yalnız secret manager'dan sağlanmalıdır**. Repoya .env veya production secret eklenmedi; CI'da yalnız sentetik ve izole localhost fixture kullanıldı. Ters proxy/TLS termination topolojisi, cookie domain, kayıt/e-posta teslimi, native Keychain/Keystore ve MFA onaylanana dek mod açılmamalıdır.

## CI kanıtı

`bash infra/lab.sh web-auth-https-smoke` sadece Folio `folio_test` DB, OpenSSL ile oluşturulmuş geçici sertifika ve gerçek loopback HTTPS NestJS ile: varsayılan 404, gerçek TLS yokken forged proxy 503, yanlış Origin/mixed credentials 401/403, yanlış parola ve bilinmeyen hesap için genel 401, başarılı girişte secure cookie 204 ve JSON'da token yokluğu, CSRF bootstrap/korumalı logout, revoke sonrası 401, 15dk hesap kotası 429 ve `Retry-After`, missing key 503 ve ayrı public OpenAPI rotalarını test eder. Düz HTTP ile gerçek hesap girişine izin verilmez. Eski unit/integration/Expo Web/Android/iOS JS/Chrome E2E/Docker image build kontrolleri sürer.

**Kalan #30:** public kayıt, SMTP dispatcher, doğrulanmış email linkleri, password reset HTTP, native client login/security, gerçek TLS proxy sınırı, admin MFA, tarayıcı/cihaz kabul testleri. **#7 bağımlılık release gate ayrıca BLOCKED**. Bu PR tamamlanmış V1 veya canlı dağıtım değildir.


## Remote session revocation and stale HttpOnly cookie recovery (#30)

Verified browsers must recover safely when another trusted device revokes their session. The login route deliberately denies any existing Cookie (session fixation defense), so leaving a revoked `__Host-folio_session` in the browser otherwise prevents re-authentication.

After **actual application TLS**, valid CSRF HMAC configuration and an **exact same-origin proof** are checked, `GET /v1/auth/web/csrf` clears that cookie with `Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` **only when the backend returns 401 Unauthorized** for a missing/invalid/revoked/disabled verified session. It still returns 401 and never issues a fresh CSRF token or authenticated state. A cross-site or origin-less request must never clear the cookie; database outages remain 503 and do not clear it. The browser naturally uses the expired Set-Cookie and can render sign-in after the unsuccessful bootstrap. An already-loaded profile with a remotely revoked session may need a page refresh to run the bootstrap; private endpoints still return 401 immediately.

The two existing genuine ephemeral TLS + Folio-only PostgreSQL smoke suites test post-logout and owner-revoked cookies, Set-Cookie attributes, cross-site/headerless denial and no CSRF token. This change does **not** enable production TLS/proxy or satisfy public signup, native secure storage, email, MFA, browser/device QA, or #7 release-security gate.
