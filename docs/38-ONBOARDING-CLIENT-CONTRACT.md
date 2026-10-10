# #30 Stateless Web / Expo onboarding client

**Kapsam:** `@folio/contracts` içinde `fetchOwnOnboarding` ve `updateOwnOnboarding` metotları, gerçek sunucu `/v1/me/onboarding` GET/PATCH için platformdan bağımsız saf fetch istemcisidir. Yanıt `onboardingSnapshotSchema`, PATCH `onboardingUpdateRequestSchema` ile doğrulanır. Kullanıcı kimliği bir alan olarak istemci tarafından seçilemez.

- Çağıran taraf **zaten doğrulanmış** 43 karakterlik bearer token'ı parametre olarak verir. Bu paket token'ı `localStorage`, `AsyncStorage`, cookie, dosya veya global değişkende saklamaz; yeni token oluşturmaz.
- `credentials:'omit'`, `cache:'no-store'`, yalnız `Authorization: Bearer …` başlığıyla, `/v1/me/onboarding` sabit yolu kullanılır. HTTPS zorunludur; sadece `localhost` veya `127.0.0.1` doğrudan test ortamı için HTTP istisnasıdır. User:password URL bilgisi veya base URL altında farklı path reddedilir.
- 409 `CONFLICT` durumunda `OnboardingVersionConflictError` kullanılır. Ekran, sunucudan güncel snapshot'ı yeniden alıp bekleyen offline işleme kullanıcı tercihlerini ezmeden uzlaştırmalıdır. 401 (revoked session) ve 503 (sunucu/DB erişilemez) ayrı `OnboardingHttpError` durumlarıdır. Sunucu request ID hata nesnesinde korunur, bearer token mesajlara yazılmaz.
- Unit testleri header/cookie/cache/network sınırı, strict body + userId injection reddi, 409/401/503 ayrımı, yanıtta Zod doğrulaması ve TLS zorunluluğunu sınar.

**Kalan:** Expo istemcide Keychain/Keystore güvenli oturum saklama, Web Secure+HttpOnly cookie / CSRF oturum modeli, gerçek sign-in/mail, onboarding UI, offline queue + conflict UX ve Android/iOS native cihaz E2E ayrı kabul kapılarıdır. Bu istemci V1'i tamamlamaz, üretime dağıtılmaz.
