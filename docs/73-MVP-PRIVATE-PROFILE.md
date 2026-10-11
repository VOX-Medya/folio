# #39 MVP | Varsayılan gizli profil ve hesap veri kontrolü

- Gerçek DB şeması eski `user_onboarding` kaydını genişletir. Yeni hesapların adı boş, görünürlüğü **private** ve locale `tr`; TR/EN değişikliği eski onboarding sürümüyle aynı satırda tutularak iki kaynak oluşturulmaz.
- `GET/PATCH /v1/me/profile`: doğrulanmış aktif oturum+cihaz, doğrudan HTTPS, tarayıcı same-origin HttpOnly cookie/CSRF ve `expectedVersion` CAS; eski sürüm 409, kötü payload 400, oturumsuz 401.
- İstek hiçbir `userId` kabul etmez, kullanıcı/profil dizini ve search route yok. `visibility=friends` tercihi veritabanında tutulsa da #40 karşılıklı arkadaş kabul API'si yayınlanmadan diğer hesaba veri açılmaz. Dış kullanıcı GET/PATCH yalnız **kendi** profilini okur/yazar.
- `POST /v1/me/profile/deletion-request` iki aşamalı kullanıcı onayıyla yalnız silme talebini saklar, audit yaratır, mevcut kullanıcı verisi/sessions silinmez. Silme/anonimleştirme hukuki iş akışı #48.
- Audit olaylarında e-posta/görünen ad veya oturum tokenı tutulmaz, sadece değişiklik işareti, sürüm ve görünürlük tutulur.
- Expo Web TR/EN ad/gizlilik ayarı ve silme talebi sağlar. Native JS export native credential / cihaz sertifikası değildir.
- `e2e/private-profile-live.spec.ts`: gerçek Chrome/Expo + direct TLS Nest + Folio-only PostgreSQL; varsayılan private, sahibi PATCH, başka hesap boş/ayrı profil, forged owner param 400, stale CAS 409, silme talebi kayıt.
- `ci:full` GitHub Actions sonucu doğrulanmadan issue tamamlanmış sayılmaz.
