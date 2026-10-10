# #30 Eşzamanlı cihaz oturumu kotası (kısmi)

Önceki dahili `signInVerifiedAccount` doğrulanmış kullanıcıya 30 günlük cihaz oturumu oluşturuyordu fakat kullanıcı başına etkin oturum üst sınırı yoktu. Bu değişiklik `MAX_ACTIVE_DEVICE_SESSIONS = 8` uygular. Her başarılı giriş sonrası yalnız SHA-256 token digest'i saklanır; ham session token audit veya DB tablosuna yazılmaz.

## Tutarlılık ve güvenlik

- Girişin **parola ve doğrulanmış hesap** kontrolünden sonra, sunucunun `user_accounts FOR UPDATE` kilidi altında, `revoked_at IS NULL AND expires_at > now` için mevcut cihaz oturumları sayılır. Limit dolduysa yeni token veya session audit yaratılmadan hata verilir; otomatik cihaz çıkarma yapılmaz.
- İki ayrı PostgreSQL pool üzerinden aynı anda açılan oturumlar bile aynı hesap row-lock altında sıraya girer. Logout/revoke sonrasında kontenjan açılır. Süresi dolmuş oturumlar fiziksel audit kaydı kalsa bile etkin cihaz olarak sayılmaz.
- Şema, migration, önceden kaydedilmiş oturumlar, okuyucu ilerlemesi ve kişisel kitaplar değiştirilmez. E-posta hesabı/pwd credential gerçek HTTP istemcisine açılmaz; mail/SMTP veya public login endpoint eklenmez.
- Test `bash infra/lab.sh session-cap-smoke` yalnız Folio `folio_test` DB'de iki pool, 12 eşzamanlı girişten 8 kabul + 4 ret, expired token ret, revoke + yeni giriş, DB satırı/audit eşleşmesi ve hassas verinin audit'te yer almaması senaryolarını doğrular. CI'nın önceki auth/onboarding/rights/import testleri de korunur.

## Kalan işler

Web/native device session management UI, güvenli token taşıma/saklama, kullanıcıya cihaz adını değiştirme, brute-force ve IP proxy entegrasyonu, 429/CSRF, admin MFA, HTTP E2E ve gerçek cihaz testleri tamamlanmadı. Bu PR yalnız dahili sağlamlaştırmadır. #30 açık, release gate ve prod dağıtım kapalı kalmalı.
