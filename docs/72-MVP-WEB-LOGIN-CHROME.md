# #30 MVP | Chrome web oturum kabulü

- Gerçek kullanıcı giriş/çıkış, cihaz oturumları ve TR/EN onboarding bileşenleri mevcut; doğrulanmış kullanıcı e-posta/parola kaydı ile direct TLS cookie akışı.
- `e2e/public-shelf-live.spec.ts` sentetik, izole PostgreSQL'de gerçek Chrome profil giriş/yanlış parola/başarılı parola/onboarding/oturumlar, erişim ve CSRF-logout sonrası 401 kontrolünü içerir.
- Güvenli `__Host-folio_session` HttpOnly/Secure/SameSite=Strict cookie, sunucu CSRF, oturum iptali ve RBAC/MFA ayrımı korunur. Şifre ve bearer tarayıcı depolamasına yazılmaz.
- Sunucu `registerPendingAccount` ve tek kullanımlık e-posta doğrulama primitive'i hazır, ancak halka açık self-signup ve doğrulama e-posta sevki mevcut değildir. Bu bağımlılık insan/onay gerektirir, #48 release kararında açık kalmalıdır; signup bitirildi iddia edilmez.
- Bu PR yeni auth bypass / login endpoint'i kurmaz. Android/iOS native credentials ve signing #48'de ayrıca kanıtlanacaktır.
