import {useEffect,useState} from 'react';
import type {CSSProperties,MouseEvent} from 'react';
import {paperbound,typography} from '@folio/ui-tokens';
import {AdminMfaPanel} from './AdminMfaPanel.js';
import {AdminCatalogPanel} from './AdminCatalogPanel.js';

type Language='tr'|'en';
const pages=[
  {id:'dashboard',tr:'Genel Bakış',en:'Overview'},
  {id:'works',tr:'Eserler',en:'Works'},
  {id:'authors',tr:'Yazarlar',en:'Authors'},
  {id:'editions',tr:'Baskılar',en:'Editions'},
  {id:'rights',tr:'Yayın Hakları',en:'Rights'},
  {id:'import',tr:'İçe / Dışa Aktar',en:'Import / Export'},
  {id:'files',tr:'Özel Dosyalar',en:'Private Files'},
  {id:'members',tr:'Üyeler',en:'Members'},
  {id:'moderation',tr:'Moderasyon',en:'Moderation'},
  {id:'audit',tr:'Denetim',en:'Audit'},
  {id:'settings',tr:'Ayarlar',en:'Settings'},
] as const;
type PageId=(typeof pages)[number]['id'];

const future=[
  {tr:'Otomatik kaynak senkronu',en:'Automatic source sync'},
  {tr:'AI çeviri / TTS üretimi',en:'AI translation / TTS generation'},
  {tr:'Harici sağlayıcılar',en:'External providers'},
] as const;

function currentPage():PageId{
  if(typeof window==='undefined')return 'dashboard';
  const path=window.location.pathname.replace(/^\/admin\/?/,'').replace(/\/$/,'');
  return pages.find(item=>item.id===path)?.id??'dashboard';
}
function systemDark():boolean{
  return typeof window!=='undefined'&&window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function App(){
  const [dark,setDark]=useState(systemDark);
  const [language,setLanguage]=useState<Language>('tr');
  const [activePage,setActivePage]=useState<PageId>(currentPage);
  useEffect(()=>{
    const preference=window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange=(event:MediaQueryListEvent)=>setDark(event.matches);
    setDark(preference.matches);
    preference.addEventListener('change',handleChange);
    return ()=>preference.removeEventListener('change',handleChange);
  },[]);
  useEffect(()=>{
    const onPopState=()=>setActivePage(currentPage());
    window.addEventListener('popstate',onPopState);
    return ()=>window.removeEventListener('popstate',onPopState);
  },[]);
  const palette=dark?paperbound.admin.dark:paperbound.admin.light;
  const style={
    '--folio-bg':palette.bg,'--folio-surface':palette.surface,
    '--folio-surface2':palette.surface2,'--folio-ink':palette.ink,
    '--folio-muted':palette.accessibleMuted,'--folio-line':palette.line,
    '--folio-accent':palette.accent,'--folio-accent-on':palette.accentOn,
    background:palette.bg,color:palette.ink,fontFamily:typography.ui,minHeight:'100vh',
  } as CSSProperties;
  const selected=pages.find(page=>page.id===activePage)??pages[0]!;
  const navigation=(event:MouseEvent<HTMLAnchorElement>,page:PageId)=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();
    window.history.pushState(null,'',`/admin/${page}`);
    setActivePage(page);
  };
  return(
    <main className="folio-admin" data-paperbound-theme={dark?'dark':'light'} style={style}>
      <a className="folio-skip" href="#admin-content">{language==='tr'?'İçeriğe geç':'Skip to content'}</a>
      <header className="folio-topbar">
        <div className="folio-brand">
          <h1 style={{fontFamily:typography.heading}}>Folio Admin</h1>
          <span>{language==='tr'?'Editoryal çalışma alanı':'Editorial workspace'}</span>
        </div>
        <div className="folio-topbar-actions" aria-label={language==='tr'?'Dil':'Language'}>
          <button type="button" onClick={()=>setLanguage('tr')}
            aria-pressed={language==='tr'} lang="tr">TR</button>
          <button type="button" onClick={()=>setLanguage('en')}
            aria-pressed={language==='en'} lang="en">EN</button>
        </div>
      </header>
      <div className="folio-admin-layout">
        <aside className="folio-sidebar" aria-label={language==='tr'?'Yönetim gezintisi':'Admin navigation'}>
          <nav aria-label={language==='tr'?'V1 modülleri':'V1 modules'}>
            <span className="folio-nav-caption">FOLIO V1</span>
            <div className="folio-nav-items">
              {pages.map(page=><a key={page.id} href={`/admin/${page.id}`}
                data-route={page.id}
                aria-current={activePage===page.id?'page':undefined}
                onClick={event=>navigation(event,page.id)}>
                {page[language]}</a>)}
            </div>
          </nav>
          <div className="folio-future" aria-label={language==='tr'?'V1 sonrası kapalı modüller':'Unavailable later modules'}>
            <span className="folio-nav-caption">{language==='tr'?'V1 SONRASI':'AFTER V1'}</span>
            {future.map(module=><span key={module.en} aria-disabled="true">{module[language]}</span>)}
          </div>
        </aside>
        <div className="folio-content-layout">
          <section id="admin-content" className="folio-workspace" tabIndex={-1} aria-live="polite">
            <div className="folio-breadcrumb">Folio / {selected[language]}</div>
            <h2 style={{fontFamily:typography.heading}}>{selected[language]}</h2>
            {(activePage==='authors'||activePage==='works')
              ?<AdminCatalogPanel key={activePage} kind={activePage} language={language}
                theme={dark?'dark':'light'}/>
              :activePage==='settings'
                ?<>
                  <p>{language==='tr'
                    ?'Doğrulanmış oturum ve MFA yönetimi. İçerik erişimi ayrıca sunucu rolüne bağlıdır.'
                    :'Verified session and MFA management. Catalog access also requires the server role.'}</p>
                  <AdminMfaPanel language={language}/>
                </>
                :<>
                  <p>{language==='tr'
                    ?'Temel uygulama kabuğu. Bu bölümün yönetim işlevleri henüz etkin değil.'
                    :'Foundation shell. Operations for this section are not enabled yet.'}</p>
                  <div className="folio-state" role="status">
                    <strong>{language==='tr'?'Yetki doğrulaması gerekli':'Authentication required'}</strong>
                    <p>{language==='tr'
                      ?'Gerçek bir yönetici oturumu ve sunucu RBAC kontrolü kurulmadan içerik, üye ve dosya bilgileri görüntülenmez.'
                      :'No content, members or files are shown until the server validates an administrator session and roles.'}</p>
                  </div>
                </>}
          </section>
          <aside className="folio-inspector" aria-label={language==='tr'?'İşlem durumu':'Action status'}>
            <h3>{language==='tr'?'İşlem Durumu':'Action Status'}</h3>
            <p>{language==='tr'?'Taslak arayüz. Canlı metrik veya sahte işlem sonucu bulunmuyor.'
              :'Draft interface. No live metrics or simulated successful actions.'}</p>
          </aside>
        </div>
      </div>
    </main>
  );
}
