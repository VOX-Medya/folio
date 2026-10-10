# #30 Kalıcı giriş/kayıt/sıfırlama kötüye kullanım kapısı (dahili)

Bu modül **henüz herkese açık login API değildir**. `admitAuthAttempt` çağrısı gerçek parola hash kontrolü, kayıt veya reset challenge üretiminden **önce** güvenilir NestJS sunucu giriş zinciri tarafından yapılmalıdır. Girdi maili ve IP adresi istemcinin `X-Forwarded-For` veya `x-user-id` başlığından körü körüne alınamaz. IP, doğrudan sunucu socket'ından veya önceden açıkça yetkilendirilmiş reverse proxy zincirinden türetilmelidir.

### Politika ve izolasyon

- Folio yalnız tek PostgreSQL `auth_rate_buckets` tablosu kullanır (Drizzle forward-only `0012_auth_abuse_rate_guard`). Redis, RabbitMQ, mikroservis, harici auth servisi eklenmez.
- Sayaç anahtarları uygulama scope/action ve normalize hesap e-postası ya da kanonik IPv4/IPv6 adresinin HMAC-SHA256 özetidir. DB, audit, istemci raporu içinde **ham e-posta, IP adresi veya HMAC secret saklanmaz**.
- HMAC anahtarı güvenilir server konfigürasyonunda **32 bayt, küçük harf hexadecimal (64 karakter)** olmalıdır. Anahtar eksik/geçersizse istek hata verir ve fail-closed davranılır. Testlerde ephemeral rastgele anahtar kullanılır; production secret repo veya GitHub artifact içine koyulmaz.
- 15 dakikalık hesap ve ağ pencereleri: login hesap başına 5 / ağ başına 30; signup hesap 3 / ağ 20; reset hesap 3 / ağ 20. Her istek, kabul edilmese bile sayılır. Eşik aşılırsa 15 dakikalık blok zamanı döner; HTTP bağlandığında genel 429/Retry-After yanıtı olmalı, hesap var/yok ayrımı ifşa edilmemeli. Nihai eşik değerleri gerçek trafik/abuse testleriyle ayrıca değerlendirilmelidir.
- İki scope'un digest'leri sıralanır, PostgreSQL transaction'da ayrı row lock alınır, sayaç güncellemeleri atomik yapılır. Böylece eşzamanlı iki worker aynı kullanıcı veya ağ kotasını aşamaz; çift kilit sırası deadlock riskini sınırlar.
- Pencere sonundaki kayıtlar bakım/retention işiyle temizlenmelidir; henüz GC worker yok. Sınırsız hesap oluşturma/kötüye kullanım, IP değişikliği, gerçek SMTP teslimi ve public rate-limit E2E ayrıca gereklidir.

### Test

`bash infra/lab.sh auth-rate-smoke` yalnız `folio_test` içinde iki bağımsız PostgreSQL pool ile 12 eşzamanlı aynı-mail login isteği dener (tam 5 kabul), değişik e-postalarla ağ sınırı 30, login/reset eylem ayrımı, 16 dakika sonra pencere yenilemesi, IPv6 eşdeğer adres kanonikleştirmesi, boş HMAC anahtarı ve geçersiz client-IP reddi, DB'de yalnız opaque digest saklanması. PostgreSQL, Expo Web/Android/iOS JS, Chrome E2E ve Docker (deploysuz) CI ile denetlenir.

**Eksikler:** NestJS request integration, production-güvenilir proxy/IP/HMAC key yönetimi, session cookie/CSRF, admin MFA, SMTP, login endpoint, account/device abuse çözümlemesi ve per-user revoke; #30 tamamlandı değildir. Açık production deploy veya gerçek kullanıcı kaydı yapılmaz.
