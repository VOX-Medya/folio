# #30 Sunucu tarafı doğrulanmış bearer-session guard (kısmi)

`apps/server/src/common/session-guard.ts` içindeki `FolioSessionVerifier`, daha önce izole PostgreSQL'de test edilmiş `@folio/db.authenticateUserSession` işlevini çağırır. Gerçek token doğrulamasında yalnız SHA-256 digest eşleşen, süresi dolmamış, geri çekilmemiş ve e-postası doğrulanmış aktif hesabın `{userId,sessionId}` kimliği alınabilir.

`VerifiedBearerSessionGuard`, yalnız tam biçimli `Authorization: Bearer <43 karakterli rastgele token>` değerine güvenir. `x-user-id`, `x-admin-role`, body ve query bilgilerini kimlik olarak kullanmaz. Önceden istek üzerinde mevcut `auth` alanı temizlenir; doğrulama başarısızsa 401, başarı halinde yalnız `userId/sessionId` bağlanır. Admin rolü **verilmez**.

`apps/server/src/session-guard-http.spec.ts` gerçek NestJS loopback HTTP dinleyicisi ve sentetik verifier ile sahte kullanıcı/rol header'larını, unknown/bad/basic/bearer formatlarını negatif test eder. `packages/db/scripts/auth-smoke.ts` ayrıca gerçek PostgreSQL `folio_test` üzerinde salt hash'li oturumları, parola resetini, 2 cihazı ve account disable/revoke işlemlerini doğrular. Test controller'ı üretim `AppModule` içinde **YOKTUR**.

## Release'e açılmadan önce

Public register/login/reset endpointleri, mail dispatcher, brute-force/rate-limit, CSRF/cookie SameSite/Secure, native secure storage, session refresh politika/testi, admin MFA ve kalıcı admin rol üyelikleri henüz yoktur. Bu guard gerçek bir route'u tek başına public yapmaz. Admin ve private asset endpointleri, kullanıcı oturumu + sahiplik + admin RBAC/telif gate birlikte tamamlanana dek devre dışı kalır. Hiçbir production deploy/market submission yapılmadı. #30 ve #43 `completed` sayılamaz.
