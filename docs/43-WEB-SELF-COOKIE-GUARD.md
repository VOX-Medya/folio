# #30 Doğrulanmış Web çereziyle kullanıcı verilerine erişim (kısmi)

Mevcut `VerifiedSelfSessionGuard`, `/v1/me/onboarding` GET/PATCH ile `/v1/me/sessions` GET/DELETE self-service rotalarında **iki ayrı güvenli taşıma yolu** destekler:

- Expo native/Web API bearer: `Authorization: Bearer ...`, başka hiçbir `Cookie` başlığı olmadan, `authenticateUserSession` PostgreSQL lookup ile doğrulanır; Web-cookie modu kapalı olsa da mevcut bearer akışı sürer.
- Web cookie: yalnız `FOLIO_WEB_AUTH_MODE=direct-tls-only` açıkken `__Host-folio_session`, gerçek TLS socket, konfigüre edilmiş HTTPS origin, aynı-site Fetch Metadata ve DB-backed aynı principal doğrulaması. Yanıtlar private/no-store. **Unsafe method** PATCH/DELETE/POST için exact Origin ve geçerli oturum-bağımlı HMAC-CSRF `X-Folio-CSRF` zorunlu. Güvenilir cookie ile Authorization birlikte gönderilirse HTTP 401. Cookie'den admin rolü, başka kullanıcı kimliği veya özel kitap paylaşımı türetilmez.
- Web oturumunda GET de cross-site `Origin` ve `Sec-Fetch-Site` iddialarını reddeder. Disabled mode HTTP 401; plain HTTP'de spoofed `X-Forwarded-Proto` ile erişim 503. Native bearer kendi eski route davranışını korur.

`@nestjs/swagger` OpenAPI `folioWebSession` cookie security şemasını `folioSession` bearer yanında OR olarak belgeliyor. Cookie authentication, bearer tokenu client JavaScript'e açmaz; Web istemcisi CSRF tokenı `/v1/auth/web/csrf` üzerinden alır ve memory'de tutar.

`bash infra/lab.sh web-self-https-smoke` yalnız izolasyonlu Folio `folio_test` ve geçici gerçek loopback TLS üzerinde: synthetic verified account oluşturur, feature-gated Web login çerezi alır, web cookie ile owner GET/PATCH onboarding, cookie+native header crossover 401, cross-site GET 403, csrf eksik/yanlış 403, stale optimistic version 409, session inventory sahibi olma, self-device DELETE + sonrası 401, native bearer sürecinin bozulmaması ve audit/doğru OpenAPI doğrulaması yapar.

**Önemli:** Tek uygulama halen normal `createFolioApp` ile HTTP dinliyor; ters proxy gerçek güven zinciri, SSL cert & secret manager, native secure token store ve Web UI güvenlik kabulü olmadan `direct-tls-only` modu production'da açılmaz. #30 kayıt/e-posta doğrulama teslimi, password-reset API, admin MFA, native/UI E2E eksik. #7 yüksek/orta advisory yayın engeli ayrıca açık. Hiçbir production build/deploy yok.
