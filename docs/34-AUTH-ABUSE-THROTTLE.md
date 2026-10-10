# #30 Dahili PostgreSQL kimlik doğrulama deneme sınırı (kısmi)

Bu değişiklik **public login/register/reset route'u açmaz**. Kaynağı doğrulanmış IP ve normalize e-posta için, PostgreSQL'de iki ayrı sabit 15 dakikalık sayaç tutan dahili `consumeAuthAttemptRateLimit` önkoşulunu ekler. Herkese açık endpoint ve gerçek e-posta teslimi halen kapalıdır.

## Sözleşme

- Eylem bazında üst sınırlar: `login` IP başına 20 / hesap başına 5; `register` IP başına 6 / e-posta başına 2; `password_reset` IP başına 10 / hesap başına 3, her biri 15 dakikada. İşlem **öncesinde** izin alınır; limit dolarsa `AuthRateLimitExceeded` fırlatılır. Limit aşıldığında iki bucket artışı birlikte geri alınır.
- Aynı e-posta farklı IP'den denenince hesap sayacı, aynı IP farklı hesaplara saldırınca IP sayacı kısıtlar. Paralel API instance'larında `INSERT ... ON CONFLICT ... WHERE attempts < limit` aynı PostgreSQL row lock üzerinden kabul sayısını sınırlar, bucket lock sırası deterministiktir.
- `AUTH_ABUSE_HMAC_KEY` gelecekteki sunucu entegrasyonunda secret manager'dan alınacak **kalıcı 32 bayt rastgele hex** anahtardır. Bu PR'da ortam veya production secret **eklenmedi**. Anahtar yoksa geçersizdir, sessiz fallback yoktur. DB'ye sadece HMAC-SHA256 bucket digest, tür, eylem, zaman ve sayaç kaydedilir; açık IP/e-posta saklanmaz. IPv6 eşdeğer gösterimleri normalize edilir.
- `trustedClientIp` asla kontrolsüz `X-Forwarded-For` üzerinden alınmamalı; yalnız doğrudan TCP peer veya önceden güvenilir proxy adresi doğrulanmış sunucu middleware'inden geçirilmelidir. Proxy/yönetim yapılandırması yapılmadan public auth route açılamaz. Tüm eylemler, şifre doğrulaması veya challenge oluşturulmasından **önce** throttling'i çağırmalıdır.
- Ekleme migration'ı `0012_auth_attempt_limits` yalnız yeni Folio tablosu açar; mevcut kitap, kullanıcı, oturum ve çeviri kayıtlarına dokunmaz. `pruneExpiredAuthAttemptWindows` 48 saatten eski satırları çağrı başına en fazla 1000 kayıt olarak siler. Zamanlanmış işletim işi henüz kurulmadı, görev kapatılmaz.

## Kanıt / eksikler

`packages/db/src/auth-rate-limit.spec.ts` salt anahtar kapsamı, TR/EN'den bağımsız e-posta normalizasyonu, IPv6 ve geçersiz IP/secret kontrollerini yapar. `bash infra/lab.sh auth-rate-smoke` yalnız `folio_test` üzerinde iki bağımsız PostgreSQL pool yarışını test eder: 12 eşzamanlı login girişinden en fazla 5'i kabul edilir, IP değiştirerek hesap limiti aşılamaz, farklı eylemlerin kotaları ayrıdır, PostgreSQL'de PII/raw HMAC key yoktur, eski bucket temizliği aktifi silmez. GitHub Actions CI geçmişteki bütün testlere ek olarak bu testi de çalıştırır.

**Kapanış engelleri:** gerçekte oturum açan HTTP servisinin IP/proxy güven sınırı, kullanıcı sayımı önleyici yanıtları, rate-limit 429 + Retry-After, dağıtık bot politikası, abuse gözlemlenebilirliği, mail provider, secure cookie/CSRF, native token store, admin MFA ve native/UI E2E. Rate limiter'ı tek başına 'auth güvenli' veya #30 completed olarak değerlendirmeyin. Canlı deploy, mail gönderimi ya da test dışı DB erişimi yok.
