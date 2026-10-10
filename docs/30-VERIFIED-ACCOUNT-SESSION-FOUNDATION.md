# #30 Self-hosted hesap ve oturum temeli (kısmi, yalnız dahili servis)

## Sınırlar

`user_accounts`, `password_credentials`, `auth_challenges` ve `user_sessions` tabloları ileri yönlü Drizzle `0010_verified_auth_sessions` migration ile eklenir. **Mevcut yazar, eser, hak, medya veya kişisel kitap kayıtlarına dokunulmaz.** Bu servis bir SMTP/e-posta teslim sistemi, kimlik doğrulamayı tamamlamış API veya oturum açılabilen uygulama değildir. Gerçek giriş/kayıt ekranları ve sunucu rotaları bilinçli olarak aktif edilmemiştir.

- Kayıt `pending_email` başlar. Parola Node.js `scrypt` ile rastgele 16 bayt tuz, N=16384/r=8/p=1, 64 bayt çıktı biçiminde saklanır; **parola metni** hiçbir DB/audit satırına girmez. Parola 12–128 karakter olmalıdır.
- Onay ve sıfırlama challenge'ları 32 bayt CSPRNG bearer olarak oluşturulur, yalnız SHA-256 özeti saklanır ve 15 dakika geçerlidir. Challenge tek kullanımlıktır; aynı account row lock altında token tüketimi ve yetki değişimi atomik olarak yapılır. Sonraki sıfırlama isteği önceki kullanılmamış sıfırlama token'larını geçersiz kılar.
- E-posta onayı yapılmamış, devre dışı veya şifresi yanlış hesap oturum alamaz. Bilinmeyen e-posta adresleri için de pahalı hash yolu kullanılır, genel hata döner.
- Her cihaz oturumu ayrı 32 bayt bearer üretir; DB yalnız SHA-256 saklar. İptal, tüm cihazları iptal, hesap devre dışı bırakma ve parola reseti mevcut oturumların erişimini keser. Reset/parola güncellemesi ve tüm oturumların revokasyonu aynı transaction içinde olur. Şifre doğrulamadan sonra DB'de yeni oturum açarken hesap row lock altında credential hâlâ aynı mı kontrol edilir.
- Audit: `auth.account.pending`, `auth.email.verified`, `auth.reset.requested`, `auth.password.reset`, `auth.session.created`, `auth.session.revoked`, `auth.sessions.revoke_all` yalnız UUID/durum bilgisi içerir; e-posta, parola, bearer, reset token, token hash'i veya credential hash'i audit JSON'una kopyalanmaz. Erişim yetkisi kısıtlı audit saklama politikası ayrıca gerekir.
- Her fonksiyon **yalnız güvenilir dahili servis** için çağrılabilir. `registerPendingAccount` ve `issuePasswordResetChallenge` ham token döndürür, yalnız ileride kurulacak trusted mail dispatcher'ına verilmelidir. Bunları HTTP JSON yanıtına yansıtmak yasaktır. Admin rolleri bu fonksiyonlardan türetilmez ve verilmez.

## GitHub Actions doğrulama

`bash infra/lab.sh auth-smoke` yalnız Folio'ya özel `127.0.0.1:55432/folio_test` PostgreSQL üzerinde ve iki bağımsız connection pool ile sentetik hesap oluşturur. Şunları doğrular: doğrulanmadan oturum yok; tek-use verification için eşzamanlı iki deneme yalnız bir kez başarılı; yanlış parola/bilinmeyen e-posta; cihaz başına farklı hashed token ve owner; tekil cihaz revoke; reset token supersession ve paralel reset yarışı; parola resetinde tüm cihazları revoke; yeni parola ile tekrar oturum; tüm cihazları iptal; disabled hesap erişimi; audit içinde hiçbir plaintext kimlik/secret yok. Başka projelere veya gerçek kullanıcı verilerine erişim yok. Testler `pnpm check`, Expo Web/Android/iOS JS, Chrome E2E, diğer Folio DB smokes ve non-deploy Docker build ile birlikte CI'da çalışır.

## #30 kalan kabul şartları

- E-posta doğrulama/sıfırlama için gerçek ve yetkili SMTP sağlayıcı yapılandırması, e-posta gizliliği, kullanıcı sayımı önleyici genel HTTP yanıtları.
- Abuse kontrolü: kalıcı IP/account login/registration/token gönderim rate-limit, cihaz oturumu sayısı sınırı, CAPTCHA değilse karşılaştırılabilir anti-automation politika, brute-force negatif testleri.
- **Güvenli client transport:** Web'de Secure/HttpOnly/SameSite cookie, CSRF/Origin denetimi ve oturum yenileme rotasyonu; Expo native cihaz güvenli saklama. Request header rol spoofing her zaman reddedilmeli.
- Admin MFA (TOTP veya WebAuthn + recovery code), gerçek `admin_role_memberships` ve #43 varsayılan ret kontrolünün session'dan yüklenmesi. Kişisel kitap gövdesi superadmin için bile varsayılan yasak.
- Kullanıcı dil/ilgi alanı/onboarding state, cihazlar arası ilerleme; arayüz loading/empty/error/offline, şifre sıfırlama ve cihaz listesi UI; Expo Web/Android ve uygun native/iOS deneyimi.
- Gerçek kayıt/giriş API, güvenlik/erişilebilirlik/E2E, üretim oturum saklama, secret yönetimi, deployment öncesi bağımlılık denetimi. Bunlar tamamlanana kadar `#30` **OPEN** kalır; production deploy veya e-posta gönderimi açılmaz.
