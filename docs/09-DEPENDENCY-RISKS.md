# Bağımlılık ve lisans incelemesi (#7)

Ubuntu `mehmet`, 10 Ekim 2026: İlk pnpm audit sonucu 16 bulgu (2 critical, 6 high, 8 moderate). Vitest 5 ve güvenlik yaması bulunan PostCSS güncellemesinden sonra 8 bulgu (4 high, 4 moderate). Denetimin yüksek seviye kalanları:

| Paket | Güvenlik kaydı | Transitive zincir | Durum |
|---|---|---|---|
| image-size | GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr | expo / metro / image-size | Major 2.x güncellemesi Metro uyumluluğuyla test edilmeli |
| node-forge | GHSA-86w9-cpqp-85rv | expo / @expo/cli | Audit içinde yama sürümü belirtilmiyor; upstream takip edilecek |
| braces | GHSA-vfj7-8cjw-p6xm | expo / metro-file-map / micromatch | Audit içinde yama sürümü belirtilmiyor; upstream takip edilecek |

Yukarıdaki bulgular bir güvenlik onayı DEĞİLDİR. CI yüksek önem taramasını bloklamaya devam eder. Bilinmeyen lisanslar ayrıca bloke edilir. CDN/uzak kullanıcı dosyası, üretim içerikleri, token veya gerçek veri ile test yapılmadı. Gelecekte uygun upstream düzeltmeleri doğrulandıktan sonra tarama yeniden çalıştırılacaktır. `pnpm audit` çıktıları Ubuntu `/tmp/folio-audit-new.log` içinde saklandı. Kaynakta `node-forge` çoklu lisans bildirimi BSD-3-Clause seçimiyle, `MPL-2.0` içeren bağımlılıkların dağıtım bildirimleri sonraki yayın kontrolünde ayrıca doğrulanmalıdır.

### Uyum denemesi
Yamalı `image-size@2.0.4` geçici dependency override ile 10 Ekim'de denendi. Expo Web Metro export `TypeError: The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView` hatasıyla durdu. Uyumsuz major override geri alındı ve Expo Web tekrar başarıyla export edildi. Güvenlik bulguları sessizce yok sayılmayacak.

## Yerel geliştirme istisnası (10 Ekim 2026)
Kullanıcı talebiyle prototip geliştirmede bağımlılık audit çıktısı **görünür fakat CI'yı bloklamayan** kontrol olarak çalışır (`continue-on-error`). Bu bir zafiyet çözümü veya güvenlik onayı değildir. Canlı dağıtım, kullanıcı verisi, yayın hakkı ve gizlilik kapıları bu istisnaya dahil değildir. Yayın CI'sında audit tekrar zorunlu bloklayıcı olacaktır; #7 ilgili güvenlik kabul kriteri karşılanana kadar açık kalır.
