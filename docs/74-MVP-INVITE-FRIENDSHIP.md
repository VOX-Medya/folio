# #40 | Davet koduyla karşılıklı arkadaşlık (MVP)

Durum: PR #188 kabulü ve gerçek GitHub Actions doğrulaması gerektirir. Bu belge tek başına tamamlanma kanıtı değildir.

## Kullanıcı yolu

1. Doğrulanmış oturum sahibi, yalnız kendi `POST /v1/me/friends/invite` isteğiyle yeni 16 karakterlik rastgele kod üretir. Önceki kod anında geçersizleşir; yeni kod 7 gün sonra sona erer. Düz kod DB/audit/log içinde saklanmaz, yalnız HTTPS yanıtındaki ilgili hesaba gösterilir.
2. Başka bir doğrulanmış kullanıcı, kodu `POST /v1/me/friends/request` ile girer. Kimlik/email/telefon bazlı kullanıcı arama, öneri veya dizin yoktur.
3. Kod sahibi `GET /v1/me/friends` ile gelen istekleri görür ve `POST /v1/me/friends/decision` içinde `accept` veya `reject` gönderir. Yalnız alıcı kabul/reddedebilir; taraflardan biri `block` uygulayabilir.
4. Engellenmiş kullanıcı artık ilişkiyi listede göremez. Tekil hesaplar arasında yalnız bir çift kaydı bulunur. Arkadaş bilgisi, ancak karşı taraf kendi profilini `friends` olarak ayarlamışsa ve ilişki `accepted` ise isim olarak gösterilir.
5. İstemci Web'de yalnız aynı origin HTTPS + HttpOnly oturum çerezi + CSRF kullanır; native bearer ancak mevcut doğrulanmış direct TLS oturum kapısından geçebilir.

## Altyapı ve sınırlar

- `0024_invite_friendship.sql` iki tablo kurar: `friend_invites` kodların SHA-256 hash'i ve sahibi; `friend_pairs` çiftin sıralı UUID kimliği, istek sahibi ve durum. `user_accounts` doğrulanmış etkin hesap olmak zorundadır.
- `friendship.ts` owner-session kontrollü işlemleri transaction içinde uygular. Sahte `userId`, belirsiz ikinci istek veya önceki engellenmiş çift bir kullanıcı keşfi kanalı değildir.
- Normal `check` contract/unit/OpenAPI, `ci:full` izole PostgreSQL migration ve sentetik iki gerçek oturumla Expo Web → Chrome → direct TLS Nest ve negatif üçüncü kullanıcı testi kullanır. Başarılı Actions run numarası PR'a kanıt olarak eklenir.
- QR, keşif, öneri, push, gerçek uygulama signing, otomatik bildirimler ve gelişmiş kullanıcı sosyal profilleri MVP dışında kalır.

## Güvenlik / veri

Daveti yalnız bilen kişi işleme alabilir. Etkin kod 80 bit rastgele entropi taşır; bu bir parola veya login yerine geçmez. Yanıtlar hiçbir zaman yabancı hesaba user ID/email veya özel okuma rafı paylaşmaz. Audit kayıtları kod veya kullanıcı görünen adı saklamaz. Canlıya dağıtım/gerçek kullanıcı verileri için ayrıca #48 onayı gerekir.
