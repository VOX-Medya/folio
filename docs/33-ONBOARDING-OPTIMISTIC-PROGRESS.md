# #30: Onboarding dil/ilgi alanı adım takibi, backend eşzamanlama

`user_onboarding` PostgreSQL kaydı kullanıcı UUID'sine bağlıdır; V1 TR/EN, `welcome -> language -> interests -> complete` adımları, 20 adede kadar doğrulanmış ilgi alanı kimliği, optimistic `version` ve `updated_at` içerir. Yeni kullanıcı için ilk GET mevcut olmayan satırı değiştirmez, varsayılan `{stage:welcome,locale:tr,interests:[],version:0}` döndürür. İlk güncellemede kullanıcıya özel tek kayıt `ON CONFLICT DO NOTHING` ile oluşturulur; eski schema satırları değiştirilmez.

`getVerifiedUserOnboarding` ve `updateVerifiedUserOnboarding` **yalnız iç servis** fonksiyonlarıdır. Güvenilir session principal'dan gelen `userId` ile çalışır, `user_accounts.status='active'` ve doğrulanmış email zorunludur. `FOR UPDATE` PostgreSQL hesap ve onboarding kilitleriyle iki eşzamanlı cihazın aynı `expectedVersion` ile yaptığı yazmalardan yalnız biri başarılı olur. Diğeri açık conflict üretir ve istemciye eski veri silmeden yeniden okuma/uzlaştırma gerekir. Aradaki bir adım atlanamaz veya completed durumu önceki adıma indirilemez; tamamlandıktan sonra aynı adımda tercihler düzenlenebilir.

Audit yalnız `stage/version/locale/interestsCount` ve aktör UUID'sini saklar; seçilmiş ilgi alanlarının listesi audit'e kopyalanmaz. Kullanıcıyı keşfetme, arkadaş önerisi, AI kişiselleştirme, içerik üretme veya backend dışı kalıcı kullanıcı profili bu kodda yok.

CI: `bash infra/lab.sh onboarding-smoke` sentetik doğrulanmamış/aktif/disabled hesap, iki ayrı PostgreSQL bağlantısı, TR/EN seçimi, tek kazanan optimistic yarış, stale version, adım atlama/gerileme reddi, ilgi alanı benzersizliği, cross-device reload, üç atomik audit ve hesap devre dışı bırakılınca izin reddini izole `folio_test` DB'de sınar. Migrasyon `0011_resumable_onboarding` forward-only, eski şema veya kullanıcı verisini temizlemez.

**Eksikler:** gerçek Expo onboarding ekran akışı, verified session middleware bağlama, e-posta/SMTP, admin MFA, cihaz offline bekleyen işlemler, gerçek mobil/erişilebilirlik native testleri ve production auth API. Bunlar tamamlanana kadar #30 `completed` sayılamaz. Production deploy yapılmaz.
