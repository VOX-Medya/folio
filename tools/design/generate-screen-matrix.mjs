import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sourceMobile = readFileSync('design/reference/folio_ui_tasarim_studyosu.html', 'utf8');
const sourceAdmin = readFileSync('design/reference/folio_admin_tasarim_studyosu.html', 'utf8');
function literalBetween(source, first, next) {
  const prefix = `const ${first}=`;
  const start = source.indexOf(prefix);
  const end = source.indexOf(`\nconst ${next}=`, start + prefix.length);
  if (start < 0 || end < 0) throw new Error(`Reference block ${first} not found`);
  const literal = source.slice(start + prefix.length, end).trim().replace(/;$/, '');
  return runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
}
const groups = literalBetween(sourceMobile, 'GROUPS', 'SCREEN_LIST');
const nav = literalBetween(sourceAdmin, 'NAV', 'LABEL');
const mobileFuture = new Set(['queue', 'clubs', 'messages', 'premium', 'publishing', 'publish-book']);
const adminFuture = new Set(['sources', 'mapping', 'staging', 'pipeline', 'translationQueue', 'ttsQueue', 'workers', 'providers']);
const mobileLayouts = {
  onboarding: 'Phone: dikey/merkez; tablet: sınırlı genişlik; desktop: sınırlı genişlik',
  library: 'Phone: alt gezinme; tablet: 2 sütun; desktop: sidebar ve 2-4 sütun',
  reader: 'Phone: tam ekran; tablet: bölüm paneli; desktop: 60-80 karakter ve yan panel',
  discover: 'Phone: tek sütun; tablet: 2 sütun; desktop: sidebar ve çok sütun',
  social: 'Phone: alt gezinme; tablet: 2 sütun; desktop: liste ve bağlam paneli',
  profile: 'Phone: dikey; tablet: 2 sütun; desktop: sidebar ve ayar alanı',
};
const adminLayout = 'Phone: drawer ve kaydırma; tablet: kapanır inspector; desktop: 258px sidebar, 76px topbar, ~300px inspector';
const policies = new Map();
for (const row of readFileSync('tools/design/route-actions.tsv', 'utf8').trim().split('\n')) {
  const [platform, id, kind, action] = row.split('|');
  if (!platform || !id || !['read', 'write'].includes(kind) || !action) throw new Error(`Bad policy: ${row}`);
  const key = `${platform}:${id}`;
  if (policies.has(key)) throw new Error(`Duplicate policy: ${key}`);
  policies.set(key, { kind, action });
}
const used = new Set();
function entry(platform, id, title, groupId, groupLabel) {
  const future = (platform === 'mobile' ? mobileFuture : adminFuture).has(id);
  const key = `${platform}:${id}`;
  const policy = policies.get(key);
  if (!future && !policy) throw new Error(`Missing route action policy: ${key}`);
  if (future && policy) throw new Error(`Future route must not have a live action policy: ${key}`);
  if (used.has(key)) throw new Error(`Duplicate reference route: ${key}`);
  used.add(key);
  const states = future ? ['disabled'] : policy.kind === 'write'
    ? ['loading', 'validation', 'success', 'conflict', 'error', 'offline', 'permission']
    : ['loading', 'empty', 'error', 'offline', 'permission'];
  if (!future && ['reader', 'book-detail', 'audio', 'rights'].includes(id)) states.push('withdrawn');
  const layout = platform === 'mobile' ? mobileLayouts[groupId] : adminLayout;
  if (!layout) throw new Error(`Missing layout for ${key}`);
  return {
    platform, id, title, groupId, groupLabel,
    scope: future ? 'AFTER-V1' : 'V1',
    action: future ? 'Pasif: V1 navigasyonu ve API bağlantısı yok' : policy.action,
    states, layout,
  };
}
const mobile = groups.flatMap(g => g.items.map(i => entry('mobile', i[0], i[1], g.id, g.name[0])));
const admin = nav.flatMap(g => g.items.map(i => entry('admin', i[0], i[1], g.g, g.g)));
if (mobile.length !== 58 || admin.length !== 30) throw new Error(`Unexpected prototype counts ${mobile.length}/${admin.length}`);
if (mobile.filter(x => x.scope === 'V1').length !== 52 || admin.filter(x => x.scope === 'V1').length !== 22) {
  throw new Error('Reference V1/future counts diverge from the design contract');
}
for (const key of policies.keys()) if (!used.has(key)) throw new Error(`Orphan route policy: ${key}`);
const manifest = { source: 'design/reference HTML prototypes', mobile, admin };
const json = JSON.stringify(manifest, null, 2) + '\n';
const escapeCell = s => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
const lines = [
  '# Folio V1 ekran ve durum matrisi (#8)', '',
  '> Bu tablo çalışan ekran listesi değil, HTML prototiplerinden türetilmiş tasarım sözleşmesidir. Gerçek API/arayüz testleri her geliştirme issue\'sunda ayrıca gerekir.', '',
  '## Bağlayıcı varsayılan', '',
  '- Tema: **Paperbound / Parşömen**, `packages/ui-tokens` içinde semantik mobil/admin açık-koyu tokenları. Alternatif referans konseptleri etkin V1 tema motoru değildir.',
  '- UI: DM Sans (fallback system), başlık: Fraunces (fallback Georgia), okuyucu: Georgia. Harici font dosyaları ve lisansları yayımlanmadan önce ayrıca kontrol edilir.',
  '- Telefon: 0-599 px, tablet: 600-1023 px, desktop: 1024+ px. İnceleme genişlikleri **320/390/768/1024/1440/1920 px**; en az 44pt dokunma hedefi.',
  '- Dark mode, TR/EN, klavye ve odak, erişilebilirlik, dinamik font, loading/empty/error/offline/permission/success görünümleri semantik tokenlarla uygulanacaktır.',
  '- `muted` referans renginin küçük metinde kontrastı sınırlı olabilir: `accessibleMuted` kritik etiketlerde kullanılmalıdır; kontrast regresyon testi eklidir.',
  '- Eylem politikaları canlı API entegrasyonu anlamına gelmez. `AFTER-V1` satırları V1 navigasyonundan ve endpointlerinden çıkarılır.', '',
  `## Mobil: ${mobile.length} referans / ${mobile.filter(x => x.scope === 'V1').length} V1 / ${mobileFuture.size} V1 sonrası`, '',
  '| Grup | Referans ID | Ekran | Kapsam | Ana eylem politikası | Gereken durumlar | Responsive yerleşim |',
  '|---|---|---|---|---|---|---|',
  ...mobile.map(x => [x.groupLabel, '`' + x.id + '`', x.title, x.scope, x.action, x.states.join(', '), x.layout].map(escapeCell).join(' | ').replace(/^/, '| ').concat(' |')),
  '', `## Admin: ${admin.length} referans / ${admin.filter(x => x.scope === 'V1').length} V1 / ${adminFuture.size} V1 sonrası`, '',
  '| Grup | Referans ID | Ekran | Kapsam | Ana eylem politikası | Gereken durumlar | Responsive yerleşim |',
  '|---|---|---|---|---|---|---|',
  ...admin.map(x => [x.groupLabel, '`' + x.id + '`', x.title, x.scope, x.action, x.states.join(', '), x.layout].map(escapeCell).join(' | ').replace(/^/, '| ').concat(' |')),
  '', '## Uygulama kısıtları', '',
  '- Kitap ve yazar araması izinlidir; kullanıcı arama, kullanıcı keşfi ve arkadaş önerisi yoktur.',
  '- Offline istemci yalnızca cache ve bekleyen işlem tutar; kalıcı durum tek backend\'dedir.',
  '- Kişisel kitaplar diğer hesaplara açılmaz. Ortak eserler telif ve ülke hakkı onayından geçer.',
  '- Ses ve çeviri varlıkları hazır olarak yüklenir. AI üretimi, TTS üretimi, otomatik kaynak senkronu ve üretim iş kuyrukları V1\'de yoktur.',
  '- Gelecek route\'ları görünür ürün işleviymiş gibi render edilmez. Bu matris demo içeriklerini ürün verisi saymaz.', '',
];
const markdown = lines.join('\n') + '\n';
const targets = [
  ['packages/ui-tokens/src/screen-matrix.generated.json', json],
  ['docs/10-UI-SCREEN-MATRIX.md', markdown],
];
for (const [file, content] of targets) {
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== content) throw new Error(`${file} is stale; regenerate design matrix`);
  } else writeFileSync(file, content);
}
console.log(`Verified prototype matrix: mobile ${mobile.length} (V1 52); admin ${admin.length} (V1 22); ${policies.size} live action policies.`);
