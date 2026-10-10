# #30 Doğrulanmış hesaba ait cihaz oturumları: GET/DELETE (kısmi)

## Etkin self-service HTTP rotaları

- **GET `/v1/me/sessions`:** Sadece doğrulanmış bearer principal'ına ait, süresi dolmamış ve iptal edilmemiş cihaz oturumlarını `id`, `deviceLabel`, `createdAt`, `expiresAt`, `isCurrent` şeklinde döndürür. Ham bearer token, SHA-256 token digest, hesap e-postası veya admin rolü dönmez. Yanıt `Cache-Control: private, no-store` taşır.
- **DELETE `/v1/me/sessions/:sessionId`:** Yalnız aynı kullanıcıya ait oturumu hedefler. Başka kullanıcıya ait veya bulunamayan UUID: 404; geçersiz UUID: 400. Önceden iptal edilmiş kendine ait cihaz oturumu tekrar 204 döner, ikinci audit kaydı üretmez. Mevcut cihaz kendi oturumunu iptal edebilir; sonraki istek 401 olur.
- Her iki rota `VerifiedSessionGuard` ile gerçek `user_sessions.token_digest` üzerinden doğrulanır. `x-user-id`, `x-admin-role`, query/body veya URL, kimlik ya da sahiplik kanıtı değildir. Eksik, revoked ve disabled hesap için 401; DB yoksa 503 döner. Gerçek public login, register ve password reset rotaları açılmaz.

## Kilit sırası ve audit

`packages/db/src/device-sessions.ts` yalnız merkezi Folio PostgreSQL üzerinde çalışır. Okumada hesap ve mevcut oturum `FOR SHARE`; iptalde hesap ve mevcut/hedef oturum `FOR UPDATE` kilitleri kullanılır. Giriş akışıyla hesap-önce kilit sırası korunur. İki farklı cihazdan eşzamanlı hedef iptali tek audit üretir. `audit_events.request_id` istemcinin seçtiği değer değil sunucunun oluşturduğu UUID'dir. Audit'e ham token, digest ya da e-posta yazılmaz. Migration veya eski kullanıcı verisi değiştirilmez.

## Testler ve eksikler

`bash infra/lab.sh device-sessions-http-smoke` sentetik iki doğrulanmış kullanıcı ve dört cihazı sadece izole Folio `folio_test` üzerinde kullanır. Gerçek ephemeral NestJS HTTP üzerinden 200/204/400/401/404, başka kullanıcının oturumlarına erişim, sahte header'lar, oturum metadata sızıntısı, no-store, eşzamanlı revoke tek audit, kendi oturumunu iptal ve OpenAPI doğrulanır. CI TypeScript/birim, PostgreSQL, Expo Web/Android/iOS JS export, Chrome E2E ve non-deploy Docker build aşamalarıyla birlikte çalışır.

**Eksik V1 DoD:** Gerçek kayıt/giriş/mail, trusted reverse proxy, admin MFA, web secure-cookie + CSRF/Origin, native Keychain/Keystore, cihaz yönetim arayüzü, Android/iOS cihaz testleri ve üretim onayları. Bağımlılık güvenliği #7 release gate'de ayrıca açık. #30 tamamlanmış sayılmaz; canlıya dağıtım yok.
