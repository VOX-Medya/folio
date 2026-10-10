# #43 Admin RBAC: varsayılan ret ve özel kitap sınırı

`packages/contracts/src/admin-rbac.ts` V1 için tek role/permission sözleşmesi sağlar:
`superadmin`, `editor`, `rights`, `audio`, `moderator`, `read-only`. Her rolün izinleri açıkça listelenir; bilinmeyen rol veya işlem varsayılan olarak reddedilir. Özellikle `personal:book:read` izni **superadmin dahil her rol için yasaktır**. Kişisel kitap metni, admin destek/denetim ekranında varsayılan olarak görülemez.

`apps/server/src/common/admin-rbac.ts` içinde yalnız NestJS request'in güvenilir oturum çözümleyicisinden gelecek `request.auth.userId/adminRoles` alanları kullanılabilir. `x-user-id`, `x-admin-role`, sorgu/body'den gelen rol iddiaları **kimlik veya yetki sayılmaz**. `@RequireAdminPermission` decorator'ı olmayan bir rota `AdminPermissionGuard` tarafından ayrıca reddedilir. Bu guard henüz gerçek API'ye bağlanmamıştır; self-hosted login/email doğrulama/admin MFA tamamlanmadan bir HTTP route'u yeni bir role göre erişilebilir olarak ilan edilemez.

Kabul testleri: `packages/contracts/src/admin-rbac.spec.ts` rol yetkileri, bilinmeyen izinler ve süperadminin özel kitap yasağı; `apps/server/src/admin-rbac-http.spec.ts` gerçek fakat **yalnız testte kullanılan** NestJS loopback HTTP soketinde 401 kimliksiz, 403 izinsiz, 200 güvenilir rights rolü, read-only sınırı, sahte header ve eksik permission decorator testi yapar. `AppModule` bu deneme controller'ını import etmez, OpenAPI değişmez.

**Kalan #43 işi:** Kalıcı kullanıcı/rol üyeliği DB şeması ve gerçek session çözümleyicisi (#30), admin MFA, destek işlemi yetkilendirme/audit before-after, admin kullanıcı ve moderation ekranları, veri maskeleme, iki rolün çapraz yetki negatif E2E testleri, gerçek private upload ve publication rights entegrasyonu. Bu sözleşme tek başına #43 veya #30'u tamamlamaz, production deploy yetkisi vermez.
