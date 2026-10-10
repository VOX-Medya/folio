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
