# #30 Güvenilir oturum ve sahibin kaynağına erişim: test edilmiş HTTP sınırı

Kritik kural: HTTP istemcisinin `x-user-id`, `x-admin-role` veya gövdeyle gönderdiği kullanıcı/rol iddiası hiçbir zaman oturum kanıtı değildir.

`apps/server/src/common/session-auth.ts` içindeki `VerifiedSessionGuard`, yalnız `Authorization: Bearer <32 bayt random token>` biçimini kabul eder; token'ı `@folio/db.authenticateUserSession` aracılığıyla Folio DB'deki SHA-256 token kaydı, account verification ve revoke/expiry durumu üzerinden doğrulayan bir **sunucu tarafından enjekte edilmiş resolver** ile çalışır. Guard her istekte `request.auth` alanını sıfırlar; yanıtı geçerli değilse 401, DB lookup ulaşılamıyorsa 503, geçerliyse yalnız `{userId,sessionId}` yazar. Herhangi bir admin rolü veya rights rolü üretmez.

Var olan `UserOwnershipGuard`, `VerifiedSessionGuard` sonrasında `request.auth.userId === params.userId` kontrol eder. `AdminPermissionGuard` ise bu principal'da henüz rol bulunmadığından superadmin header spoofing yapıldığında dahi 403 verir. `VerifiedSessionGuard` route'larda açıkça etkinleştirilmedikçe koruma varsayılmamalıdır. Kullanılan resolver sembolü servis tarafından güvenilir bağlanmadığında NestJS DI modülü boot etmemeli; fail-open bulunmaz.

`apps/server/scripts/auth-http-smoke.ts` testte iki sentetik doğrulanmış kullanıcı oluşturur, iki ayrı SHA-hashed cihaz oturumu üretir ve **gerçek NestJS loopback HTTP soketinde** yalnız test modülünde şu negatif kabul senaryolarını çalıştırır:

- Sadece sahte `x-user-id/x-admin-role/x-request-id` başlıklarıyla istek 401.
- Başka kullanıcıya ait doğrulanmış oturumla kaynak istemek 403.
- Doğru kullanıcının doğrulanmış oturumu kendi test-only kaynağını 200 olarak görebilir.
- Erişimi olmayan kullanıcı superadmin header eklediğinde rights-review 403.
- Malformed bearer 401. Sunucunun request ID'si client header'ıyla değiştirilemez.
- Oturum revoke edildikten sonra aynı bearer ile istek 401.

CI yalnız `folio_test` için `bash infra/lab.sh auth-http-smoke` komutunu çalıştırır. Test controller **production `AppModule` veya OpenAPI içinde bulunmaz**; gerçek kullanıcı API'si açılmaz. Kullanıcı e-postası, parola, token veya gerçek kitap verisi loglanmaz. Bu test Web/Android/iOS güvenli istemci depolaması kanıtı değildir.

## Hâlâ eksik

Güvenli, üretim için çalışabilir kayıt/giriş endpointleri, e-posta/SMTP ve identity proof, IP+account bazlı rate-limit, Secure/HttpOnly/SameSite web cookie ve CSRF/Origin koruması, React Native native secure keychain/keystore, session rotation, gerçek MFA ve server admin role membership. Bu koşullar sağlanmadan production auth route'u eklenemez ve #30 completed sayılamaz. Prod deploy yok.
