/** V1 navigation only. No user search, AI-generated content or inactive future routes. */
export const mobileSections=[
  {id:'home',href:'/',tr:'Ana Sayfa',en:'Home',icon:'⌂'},
  {id:'library',href:'/library',tr:'Kütüphanem',en:'My Library',icon:'▤'},
  {id:'catalog',href:'/catalog',tr:'Kitaplar',en:'Books',icon:'⌕'},
  {id:'profile',href:'/profile',tr:'Profil',en:'Profile',icon:'○'},
] as const;

export type MobileSection=(typeof mobileSections)[number]['id'];
export type FolioLocale='tr'|'en';

export const screenCopy={
  home:{
    tr:{heading:'Okuma yolculuğun',message:'Okuyucu henüz geliştirme aşamasında.',
      detail:'Güvenli oturum, kütüphane ve okuma konumu senkronizasyonu hazırlanıyor.'},
    en:{heading:'Your reading journey',message:'The reader is still in development.',
      detail:'Secure sessions, your library and reading progress sync are being prepared.'},
  },
  library:{
    tr:{heading:'Kütüphanem',message:'Kütüphanene erişmek için giriş yapman gerekecek.',
      detail:'Kişisel kitapların ve rafların başka kullanıcılarla paylaşılmayacak.'},
    en:{heading:'My Library',message:'A verified account will be required to open your library.',
      detail:'Private books and shelves will not be shared with other users.'},
  },
  catalog:{
    tr:{heading:'Kitaplar ve yazarlar',message:'Yayımlanmış kitap ve yazarları arayabilirsin.',
      detail:'Yalnız hakları doğrulanmış ve yayımlanmış eserler listelenecek. Kullanıcı araması bulunmaz.'},
    en:{heading:'Books and authors',message:'Search published books and authors.',
      detail:'Only rights-approved published books will appear. There is no people search.'},
  },
  goals:{
    tr:{heading:'Okuma hedefleri',message:'Hedef ve istatistikler henüz etkin değil.',
      detail:'Gerçek okuma verileri kaydedilince burada görünecek; örnek sayaç gösterilmiyor.'},
    en:{heading:'Reading goals',message:'Goals and statistics are not enabled yet.',
      detail:'Real reading information will appear here later. No sample counters are displayed.'},
  },
  profile:{
    tr:{heading:'Hesap ve ayarlar',message:'Güvenli web girişi yapılandırılmış HTTPS ortamında etkinleşir.',
      detail:'Hesap erişimi doğrulanmadan profil bilgileri gösterilmez.'},
    en:{heading:'Account and settings',message:'Secure web sign-in requires configured HTTPS.',
      detail:'No account information is displayed before authentication.'},
  },
} as const;

/** Direct-link placeholders never trust route IDs as evidence of catalog access. */
export const readingRouteCopy={
  book:{
    tr:{heading:'Eser ayrıntıları',message:'Eser bilgileri yalnız yayımlanmış katalogdan yüklenir.',
      detail:'Yalnız yayımlanmış ve telif izinleri doğrulanmış eserler gösterilecek.',
      invalid:'Geçersiz eser bağlantısı.',back:'Kitaplara dön'},
    en:{heading:'Book details',message:'Book details are loaded only from the published catalog.',
      detail:'Only published books with verified rights will be shown.',
      invalid:'Invalid book link.',back:'Back to books'},
  },
  reader:{
    tr:{heading:'E-kitap okuyucu',message:'Okuyucu henüz güvenli içerik API’sine bağlanmadı.',
      detail:'Metin veya okuma konumu, sunucu oturum ve telif kontrolü olmadan yüklenmez.',
      invalid:'Geçersiz okuyucu bağlantısı.',back:'Kitaplara dön'},
    en:{heading:'E-book reader',message:'The reader is not connected to the secured content API yet.',
      detail:'Neither text nor reading progress loads without server-side session and rights checks.',
      invalid:'Invalid reader link.',back:'Back to books'},
  },
} as const;
export type ReadingRouteKind=keyof typeof readingRouteCopy;

/** Validate untrusted Expo deep-link parameters; no book content is fetched here. */
const routeUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validReadingRouteId(input:unknown):input is string{
  return typeof input==='string'&&routeUuid.test(input);
}
