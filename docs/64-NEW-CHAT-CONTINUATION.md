# Folio | Yeni Sohbet Devam Promptu

Bu sohbeti Folio MVP geliştirmesinin doğrudan devamı olarak devral.

Repo: https://github.com/VOX-Medya/folio
Kapsam kararı: https://github.com/VOX-Medya/folio/issues/170
Ana yürütme belgesi: `docs/62-MVP-EXECUTION-PLAN.md`
Proje talimatı: `docs/63-MVP-PROJECT-INSTRUCTIONS.md`
Güncel CI: `.github/workflows/ci.yml`

**İlk işlem:** GitHub API ile `main`, açık PR'lar, son Actions sonuçları, `scope:v1`+`type:task` issue'ları ve `completed` durumlarını yeniden kontrol et. Geçmiş sohbetteki PR #168 (ISBN özel durum/iki editör) ve PR #169 (Actions primary, başarılı ve merge edildi) dahil kalan PR'ların durumunu **yeniden doğrula**. #170 kararı ve docs/62 matrisinde öncelik sırasına uy; sonuçları veya issue kapatmalarını varsayma.

**Amaç:** çalışan en küçük e-kitap + RSVP + hazır ses ürünü; 1.000 kitap veya 88 demo ekran V1 kapısı değil. 29 görevlik sade MVP: V1-00 5, V1-01 9, V1-02 8, V1-03 3, V1-04 4. Eski MVP dışına alınan 11 issue `scope:future` olmalı. Gerçek ilerlemeyi **o an GitHub'daki etiket ve completed kapanışlardan** say.

**Çalışma şekli:** Desktop Commander, kullanıcı Ubuntu cihazı, SSH terminal ve başka remote development servisine ASLA bağlanma. Kod/doküman değişikliklerini GitHub'daki issue referanslı branch+PR ile yap. Test/derleme için yalnız GitHub Actions Ubuntu runner'ını kullan. Normal PR hızlı `check`; riskli PR `ci:full`; `main` üzerinde tek temel regresyon; ek maliyetli `extended` ancak gerekince. Dev advisory audit bilgisel, üretim release engeli #48'de; yetki/RBAC/MFA/CSRF, özel dosya sınırı, SHA-256 ve telif kapıları devam.

**Önce bitir:** temel CI kabulü #7, katalog #12'nin eksik **gerçek üretim kullanıcı akışına hizmet eden** maddeleri, sonra #13/#14/#18/#19/#26 ve minimal admin #21/#23. ISBN/headline edge-case defterlerine yeni bağımsız PR açma. Tam insan onayı isteyenleri issue'da açık/blocked bırak, diğer işlere geç. Gerçek native cihaz, signing, hukuki hak/onay ve production deploy sonraya; açık onay olmadan live işlem yok.

Her turda olabildiğince kodla → ilgili unit/HTTP/E2E testini GitHub Actions'ta çalıştır → logu düzelt → PR/merge → kabul sağlanıyorsa issue kapat. Test ve kabulü uydurma. Sonuna yalnız bir kez 5 faz ve genel MVP yüzdelerini, aktif fazı, son GitHub doğrulama tarihini yaz. Yeni plan üretip oyalama; ürün dikey akışını bitir.
