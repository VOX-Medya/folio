# #30 Kimliği doğrulanmış kullanıcının onboarding REST rotası (kısmi)

## Çalışan modül

\`AccountOnboardingModule\` gerçek NestJS \`AppModule\` içine bağlanmıştır. \`GET /v1/me/onboarding\` ve \`PATCH /v1/me/onboarding\` yalnız \`VerifiedSessionGuard\` üzerinden PostgreSQL'deki SHA-256 özetiyle eşleşen, iptal edilmemiş, süresi dolmamış **doğrulanmış kullanıcı bearer** kimliğiyle çalışır. \`userId\` istekten, URL'den, gövdeden, cookie'den veya gönderilen \`x-user-id/x-admin-role\` başlığından seçilmez. Admin yetkisi de otomatik oluşmaz.

- \`GET\` önceki veriyi backend'den okur, hiç kayıt yoksa başlangıç \`welcome / tr / [] / version=0\` durumunu verir; beklenmeyen query argümanları HTTP 400.
- \`PATCH\` katı \`expectedVersion/stage/locale/interests\` sözleşmesini zorunlu tutar; ek \`userId\` veya bilinmeyen alanlar HTTP 400. Drizzle account ve onboarding row lock altında cihazlar arasında optimistic version ve sıralı stage geçişi korur. Stale sürüm HTTP 409'dur. No-store private response cache policy ile 401/409 yanıtları da önbellek dışıdır.
- \`audit_events.request_id\` değeri, güvenilir \`RequestIdMiddleware\` tarafından üretilen UUID'dir. İlgi alanı dizisi, bearer token veya kimlik bilgileri audit JSON'a kopyalanmaz.
- Eksik/veritabanı erişilemeyen durumda 503; iptal/disabled/unverified hesap 401. Görevde kullanılan modül tek Folio DB handle'ı kullanır, ayrı auth servisi veya Redis eklenmez.
- OpenAPI \`docs/api/openapi.v1.json\` güncellendi; \`folioSession\` bearer şeması ve typed input/output açıklamaları tanımlandı.

## GitHub Actions kanıtı

\`bash infra/lab.sh onboarding-http-smoke\` yalnız Folio geçici \`folio_test\` veritabanına ve gerçek loopback NestJS portuna bağlanır. Sentetik iki hesap ve iki cihaz ile spoofed header/owner 401, query/body userId 400, verified GET 200, stage skip 400, başarılı PATCH, stale version 409, ikinci cihazın backend'den reload'u, request-id audit, no-store, per-device revoke 401 ve disabled hesap 401 negatif testleri çalıştırılır. Expo hedefleri ve Chrome E2E ortak CI matrisinde ayrıca çalışır.

## Kalanlar / release kapısı

Gerçek HTTP signup/login/reset/e-posta teslimi açılmadı; istemci şu aşamada yalnız dahili sentetik testte üretilen doğrulanmış bearer'ı kullanabilir. Trusted proxy IP politikası, secret manager, secure SameSite cookie/CSRF/Origin, native Keychain/Keystore, admin MFA ve rol üyelikleri, gerçek Expo onboarding UI/offline senkronu ve native cihaz kabulü hâlâ eksik. \`#30\` açık ve tamamlanmadı. \`#7\` security audit release engeli devam ediyor; canlıya dağıtım yapılmadı.
