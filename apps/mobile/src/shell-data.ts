/** V1 navigation only. No user search, AI-generated content or inactive future routes. */
export const mobileSections=[
  {id:'home',href:'/',tr:'Ana Sayfa',en:'Home',icon:'⌂'},
  {id:'library',href:'/library',tr:'Kütüphanem',en:'My Library',icon:'▤'},
  {id:'catalog',href:'/catalog',tr:'Kitaplar',en:'Books',icon:'⌕'},
  {id:'goals',href:'/goals',tr:'Hedefler',en:'Goals',icon:'◷'},
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
    tr:{heading:'Kitaplar ve yazarlar',message:'Kitap ve yazar araması henüz etkin değil.',
      detail:'Yalnız hakları doğrulanmış ve yayımlanmış eserler listelenecek. Kullanıcı araması bulunmaz.'},
    en:{heading:'Books and authors',message:'Book and author search is not enabled yet.',
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
