# #30 HTTP kimlik doğrulama deneme sınırı: TCP peer, fail-closed, test-only

## Durum

`apps/server/src/common/trusted-auth-admission.ts`; önceki `authAttemptWindows` PostgreSQL sayacını bir NestJS HTTP isteğine bağlayacak iç işlevi içerir. İşlev yalnız TCP `request.socket.remoteAddress` değerini IP kimliği kabul eder; `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `x-user-id` ve gövdedeki kimlik/IP iddiaları güvenilir sayılmaz. IP yoksa veya biçim geçersizse HTTP 503 ile reddedilir.

**Önemli:** Bu doğrudan socket-peer modeli yalnız doğrudan istemci bağlantısında doğru IP sınırını temsil eder. Ters proxy arkasında bütün istemcilerin TCP peer'i proxy olur. Proxy zinciri kuralları, güvenilir son-hop ve başlığın proxy tarafından sıfırlanması ayrıca doğrulanmadan public signup/signin/reset endpointleri aktive **EDİLMEZ**.

## Dahili admission sözleşmesi

- Request gövdesi yalnız `{action: 'login'|'register'|'password_reset', email}` kabul eder. Ek alan, client-IP veya role iddiası HTTP 400. E-posta normalize edilir; cevapta hesap varlığı veya limitlenen e-posta/IP açıklanmaz.
- Güvenilir sunucu tarafından sağlanan **kalıcı 32 bayt HMAC hex secret** olmadan 503. Gerçek secret repo/teste eklenmedi; smoke script'te yalnız sentetik test anahtarı var. Anahtar için secret manager gereklidir.
- PostgreSQL transaction failure 503 ile fail-closed; limit dolması 429 `RATE_LIMITED`, `Retry-After: 900` (15 dakika üst sınır) ve aynı sunucu UUID'si hem `x-request-id` hem API error JSON içinde. Kalıcı IP veya e-posta saklanmaz.
- Bu sınırda **parola hesaplama, challenge üretme, e-posta gönderimi veya oturum yaratma işlemi yoktur.** Public endpointlerin quota işlevini parola doğrulamasından *önce* çağırması bir sonraki entegrasyon için zorunludur.
- Test-only route (`/v1/_auth-admission-test/attempt`) yalnız ayrı bir NestJS test modülündedir. **Production AppModule ve OpenAPI bu rotayı içermez.** Repo'da gerçek public login/register/reset rotası açılmadı.

## Kanıtlar ve kalanlar

`trusted-auth-admission.spec.ts` gerçek socket IP üstünlüğünü ve sahte/eksik peer reddini sınar. `bash infra/lab.sh auth-admission-http-smoke` sadece izole `folio_test` DB'ye bağlanan gerçek loopback NestJS HTTP sunucusunda spoofed forwarding header'larını, 5/login-account ve 20/login-IP üst sınırını, eylem izolasyonunu, 429/retry-after/request-id, yanlış body 400 ve production route 404/OpenAPI dışı durumunu sınar. Önceki CI testleri, Expo hedefleri, Chrome E2E ve non-deploy Docker derleme korunur.

Kalan: trusted reverse proxy tam güven modeli, HMAC key secret yönetimi, distributed bot politikası, gerçek public auth HTTP ve e-posta doğrulama, güvenli cookie+CSRF/Origin, native Keychain/Keystore, MFA, cihaz oturumu UI ve native/E2E. Mevcut #7 audit bulguları da release engeli. #30 completed değil. Live deploy yapılmadı.
