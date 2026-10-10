# #30 Web/Expo ortak cihaz oturumları istemcisi (kısmi)

`@folio/contracts` içindeki `fetchOwnDeviceSessions` ve `revokeOwnDeviceSession`, gerçek backend `GET /v1/me/sessions` ve `DELETE /v1/me/sessions/:sessionId` endpointleri için platformdan bağımsız, state tutmayan istemcidir.

- Kullanıcı kimliği yalnız sunucunun doğruladığı bearer'dan gelir. URL/query/header/body'de seçilebilir `userId` veya client role yoktur. Yanıt DTO'su yalnız device UUID/label/createdAt/expiresAt/isCurrent alanlarını içerir; ham bearer veya digest kabul edilmez.
- Çağıran, zaten doğrulanmış 43 karakterlik bearer'ı parametre verir; paket cookie, AsyncStorage, LocalStorage veya global değişkene token yazmaz. HTTPS zorunludur, yalnız localhost loopback test istisnasıdır; URL kullanıcı adı/şifre, path/query/fragment reddedilir.
- `credentials:'omit'`, `cache:'no-store'`, `redirect:'error'` ve yalnız Authorization+Accept başlıkları kullanılır. AbortSignal desteklenir. İptal edilen UUID ağ isteğinden önce doğrulanır, body gönderilmez.
- DELETE başarı için **sadece 204** kabul eder. 401 (oturum yok/iptal), 404 (başka hesaba ait/yok), 503 (servis yok) ve diğer HTTP hataları güvenli `DeviceSessionHttpError` kodu ve sunucu request ID ile döner; hata mesajında raw token ve hedef UUID bulunmaz.
- `verified-request.ts` üzerinden onboarding ve cihaz oturumları aynı origin/bearer/API error doğrulamasını kullanır. Onboarding'e de `redirect:'error'` eklendi, önceki testler korunur.
- Unit testler: no-cookie,no-store,no-redirect-follow, no-user-ID, strict DTO, 204/idempotent response contract, 200-as-DELETE rejection, 401/404/503 request-id, invalid UUID before network, HTTPS ve localhost istisnası.

**Eksikler:** secure Web HttpOnly+SameSite cookie/Origin/CSRF ve native Keychain/Keystore, gerçek auth HTTP/email, MFA, Expo responsive cihaz oturumu arayüzü, offline hata UX, Android/iOS fiziksel/simülatör kabul testleri ve production onayı. #30 completed değil. Herhangi bir canlı dağıtım yapılmadı.
