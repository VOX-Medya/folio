# #13 MVP: Bölüm okuma sınırı

- Hazır metin ve SHA-256 doğrulaması `createContentRevision` ile Folio-only PostgreSQL'e değişmez revizyon olarak yazılır.
- Yeni bölüm okuma API'si yalnız admin `catalog:read`, aktif oturum, aynı cihaz MFA ve doğrudan HTTPS koşullarında erişilebilir olmalıdır.
- GET cevabı bölümün sıralı semantik bloklarını ve revizyon/kaynak hash referansını döndürür. Özel dosya anahtarı, hukuki kanıt veya kullanıcı sırrı dönmez.
- Bu rota **halka açık kitap okuyucu değildir**. Kullanıcıya gösterme işlemi #14 hak/ülke ve #23 yayın kapıları tamamlandıktan sonra #33 kapsamında açılacaktır.
- Test: önceki revizyon metni değişmeden kalır; bozuk SHA, yetkisiz rol, yanlış work/edition/revision zinciri ve HTTP üzerinden erişim reddedilir.
