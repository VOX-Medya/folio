import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import {AdminWorkRelations} from './AdminWorkRelations.js';
import {AdminEditionMetadataEditor} from './AdminEditionMetadataEditor.js';
import {AdminRevisionDiffPanel} from './AdminRevisionDiffPanel.js';
import {AdminFolioCoverPreview} from './AdminFolioCoverPreview.js';
import {AdminRightsLedgerPanel} from './AdminRightsLedgerPanel.js';
import {
  authorCreateSchema,workCreateSchema,
  canonicalAuthorMetadataPatchSchema,canonicalWorkMetadataPatchSchema,
} from '@folio/contracts';
import type {
  AdminCatalogAuthorDetail,AdminCatalogAuthorPage,
  AdminCatalogWorkDetail,AdminCatalogWorkPage,
} from '@folio/contracts';
import {
  CatalogClientError,catalogErrorText,createAdminAuthor,createAdminWork,
  getAdminAuthor,getAdminWork,patchAdminAuthor,patchAdminWork,
  searchAdminAuthors,searchAdminWorks,
} from './admin-catalog-client.js';

type Language='tr'|'en';
type Kind='works'|'authors';
type Item=AdminCatalogWorkPage['items'][number]|AdminCatalogAuthorPage['items'][number];
type Detail={kind:'works';value:AdminCatalogWorkDetail}|
  {kind:'authors';value:AdminCatalogAuthorDetail};
type State='idle'|'loading'|'ready'|'empty'|'error';
type Alias={name:string;locale:string};
type External={source:string;externalId:string};
const copy={
  tr:{
    info:'Yalnız doğrulanmış HTTPS, yetkili yönetici oturumu ve bu cihazda güncel MFA ile özel katalog metadata erişimi. Ortak katalog yayını değildir.',
    insecure:'HTTPS gerekli. HTTP önizlemesi özel katalog isteği göndermez.',
    offline:'Çevrimdışı. Özel katalog sorguları ve değişiklikleri kuyruğa alınmaz.',
    settings:'Oturum ve MFA ayarları',
    query:'Yazar veya eser metni',search:'Ara',more:'Sonraki sayfa',
    searchHelp:'Yalnız kitap ve yazar metadata araması. Kullanıcı araması bulunmaz.',
    idle:'Aramak için başlık veya yazar adı girin.',
    loading:'Yetkili katalog sorgusu yükleniyor…',empty:'Bu sorguyla eşleşen kayıt bulunamadı.',
    noResults:'Henüz sonuç yok.',select:'Ayrıntıları aç',
    detailLoading:'Kanonik ilişkiler yükleniyor…',close:'Ayrıntıyı kapat',
    retry:'Yeniden dene',reload:'Güncel sürümü sunucudan yükle',
    version:'Metadata sürümü',draft:'Taslak',status:'Yayın durumu',language:'Dil',
    original:'Özgün başlık',year:'İlk yayın yılı',authors:'Yazarlar',
    aliases:'Takma adlar',external:'Kaynak kimlikleri',titles:'Dil başlıkları',
    editions:'Baskılar',contributors:'Katkıda bulunanlar',identifiers:'Tanımlayıcılar',
    editEdition:'Taslak baskıyı düzenle',reviewRevision:'Revizyon farkları',viewRights:'Hak kayıtları',
    notAvailable:'Kayıtlı bilgi yok',name:'Kanonik yazar adı',sortName:'Sıralama adı',
    create:'Yeni taslak oluştur',createAction:'Taslağı kaydet',
    edit:'Metadata düzenle',save:'Sürüm kontrolüyle kaydet',cancel:'Vazgeç',
    primaryId:'Kayıtlı yazar UUID',primaryHelp:'Önce Yazarlar bölümünde yazar oluşturup doğrulanmış UUID değerini kullanın.',
    source:'Kaynak',externalId:'Kaynak kimliği',alias:'Takma ad',locale:'Takma ad dili',
    remove:'Kaldır',addAlias:'Takma ad ekle',addSource:'Kaynak kimliği ekle',
    editHelp:'Taslak baskı, katkı veren ve alternatif başlık metadata bağlantıları eklenebilir. Kaynak metin, çeviri içeriği ve yayın hakları bu ekrandan değişmez.',
    draftOnly:'Yalnız taslak eserlerin özgün başlık ve yıl bilgisi düzenlenebilir.',
    noChanges:'Kaydedilecek metadata değişikliği yok.',
    saved:'Veri sunucuda kaydedildi; güncel sürüm yeniden okunuyor.',
    created:'Sunucu yeni taslak kimliğini doğruladı. Hak onayı verilmedi.',
    validation:'Alanları ve UUID ilişkisini kontrol edin. Veri gönderilmedi.',
    saving:'Sunucuda doğrulanıp kaydediliyor…',busy:'İşlem sürüyor…',
    conflictHelp:'Kaydı sessizce tekrar göndermeyin. Önce sunucudaki güncel sürümü inceleyin.',
    limit:'Çok fazla bağlı metadata var. Bu görünümde bütün ilişkiler düzenlenemez.',
  },
  en:{
    info:'Private canonical metadata requires verified HTTPS, an authorized administrator and fresh MFA on this device. This is not public publication.',
    insecure:'HTTPS required. The HTTP preview never requests private catalog data.',
    offline:'Offline. Private catalog requests and writes are never queued.',
    settings:'Session and MFA settings',
    query:'Author or work text',search:'Search',more:'Next page',
    searchHelp:'Only book and author metadata search. There is no people search.',
    idle:'Enter a title or author to search.',
    loading:'Loading authorized catalog query…',empty:'No records match this query.',
    noResults:'No results yet.',select:'Open details',
    detailLoading:'Loading canonical relationships…',close:'Close details',
    retry:'Retry',reload:'Load latest server revision',
    version:'Metadata version',draft:'Draft',status:'Publication status',language:'Language',
    original:'Original title',year:'First publication year',authors:'Authors',
    aliases:'Aliases',external:'Source identifiers',titles:'Language titles',
    editions:'Editions',contributors:'Contributors',identifiers:'Identifiers',
    editEdition:'Edit draft edition',reviewRevision:'Revision differences',viewRights:'Rights ledger',
    notAvailable:'No stored information',name:'Canonical author name',sortName:'Sort name',
    create:'Create new draft',createAction:'Save draft',
    edit:'Edit metadata',save:'Save with version check',cancel:'Cancel',
    primaryId:'Existing author UUID',primaryHelp:'Create an author under Authors and use the verified UUID.',
    source:'Source',externalId:'Source ID',alias:'Alias',locale:'Alias language',
    remove:'Remove',addAlias:'Add alias',addSource:'Add source identifier',
    editHelp:'You may append draft edition, contributor and alternate-title metadata. Source text, translation content and publication rights remain unchanged.',
    draftOnly:'Only draft work titles and publication years can be edited.',
    noChanges:'There are no metadata changes to save.',
    saved:'The server saved your metadata; loading the latest revision.',
    created:'The server confirmed a new draft ID. Rights were not approved.',
    validation:'Check the fields and UUID relationship. No request was sent.',
    saving:'Validating and saving on the server…',busy:'Operation in progress…',
    conflictHelp:'Do not silently resubmit. Review the latest server revision first.',
    limit:'Too many linked metadata rows to edit all relationships in this view.',
  },
} as const;
function securePage():boolean{
  return typeof window!=='undefined'&&window.location.protocol==='https:';
}
function onlineNow():boolean{
  return typeof navigator==='undefined'||navigator.onLine!==false;
}
function yearValue(input:string):number|null|'invalid'{
  if(input.trim()==='')return null;
  if(!/^-?\d{1,4}$/.test(input.trim()))return 'invalid';
  const year=Number(input.trim());
  return year>=-4000&&year<=2500?year:'invalid';
}
function detailName(value:Item):string{
  return 'originalTitle' in value?value.originalTitle:value.canonicalName;
}
function translateStatus(status:string,language:Language){
  return status==='draft'?(language==='tr'?'Taslak':'Draft'):status;
}

/** No optimistic fake rows: every displayed resource and mutation result
 * comes from a fresh Zod-validated, same-origin, MFA-protected server reply. */
export function AdminCatalogPanel({kind,language,theme}:{
  kind:Kind;language:Language;theme:'light'|'dark';
}){
  const w=copy[language];
  const secure=securePage();
  const [online,setOnline]=useState(onlineNow);
  const [term,setTerm]=useState('');
  const [searched,setSearched]=useState('');
  const [items,setItems]=useState<Item[]>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [state,setState]=useState<State>('idle');
  const [searchError,setSearchError]=useState('');
  const [detail,setDetail]=useState<Detail|null>(null);
  const [detailId,setDetailId]=useState<string|null>(null);
  const [detailState,setDetailState]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  const [detailError,setDetailError]=useState('');
  const [editing,setEditing]=useState(false);
  const [editingEditionId,setEditingEditionId]=useState<string|null>(null);
  const [reviewEditionId,setReviewEditionId]=useState<string|null>(null);
  const [showRights,setShowRights]=useState(false);
  const [creating,setCreating]=useState(false);
  const [busy,setBusy]=useState(false);
  const [stale,setStale]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [name,setName]=useState('');
  const [sortName,setSortName]=useState('');
  const [title,setTitle]=useState('');
  const [year,setYear]=useState('');
  const [newLanguage,setNewLanguage]=useState<'tr'|'en'>('tr');
  const [primaryAuthorId,setPrimaryAuthorId]=useState('');
  const [aliases,setAliases]=useState<Alias[]>([]);
  const [externalIds,setExternalIds]=useState<External[]>([]);
  const [aliasesDirty,setAliasesDirty]=useState(false);
  const [externalDirty,setExternalDirty]=useState(false);
  const searchSeq=useRef(0),detailSeq=useRef(0);
  const searchAbort=useRef<AbortController|null>(null);
  const detailAbort=useRef<AbortController|null>(null);

  useEffect(()=>{
    const update=()=>setOnline(onlineNow());
    window.addEventListener('online',update);
    window.addEventListener('offline',update);
    return ()=>{
      window.removeEventListener('online',update);
      window.removeEventListener('offline',update);
      searchSeq.current++;
      detailSeq.current++;
      searchAbort.current?.abort();
      detailAbort.current?.abort();
    };
  },[]);

  function resetDraft(value:Detail){
    if(value.kind==='authors'){
      setName(value.value.author.canonicalName);
      setSortName(value.value.author.sortName);
      setAliases(value.value.aliases.map(row=>({
        name:row.name,locale:row.locale??'',
      })));
      setExternalIds(value.value.externalIds.map(row=>({
        source:row.source,externalId:row.externalId,
      })));
      setAliasesDirty(false);
      setExternalDirty(false);
    }else{
      setTitle(value.value.work.originalTitle);
      setYear(value.value.work.firstPublicationYear===null?'':String(value.value.work.firstPublicationYear));
    }
  }
  async function loadDetail(id:string,keepMessage=false){
    const ticket=++detailSeq.current;
    detailAbort.current?.abort();
    const controller=new AbortController();
    detailAbort.current=controller;
    setDetailId(id);setDetail(null);setDetailState('loading');
    setEditingEditionId(null);setReviewEditionId(null);setShowRights(false);
    setDetailError('');setEditing(false);setStale(false);setError('');
    if(!keepMessage)setMessage('');
    try{
      const next:Detail=kind==='authors'
        ?{kind:'authors',value:await getAdminAuthor(id,controller.signal)}
        :{kind:'works',value:await getAdminWork(id,controller.signal)};
      if(ticket!==detailSeq.current)return;
      resetDraft(next);
      setDetail(next);setDetailState('ready');
    }catch(cause){
      if(ticket!==detailSeq.current)return;
      setDetailState('error');setDetailError(catalogErrorText(cause,language));
    }
  }
  async function runSearch(query:string,cursor?:string){
    if(!secure||!online||busy)return;
    const ticket=++searchSeq.current;
    searchAbort.current?.abort();
    const controller=new AbortController();
    searchAbort.current=controller;
    if(!cursor){setItems([]);setNextCursor(null);setSearched(query);}
    setState('loading');setSearchError('');
    try{
      const page=kind==='authors'
        ?await searchAdminAuthors(query,cursor,controller.signal)
        :await searchAdminWorks(query,cursor,controller.signal);
      if(ticket!==searchSeq.current)return;
      setItems(current=>cursor?[...current,...page.items.filter(item=>
        !current.some(existing=>existing.id===item.id))]:page.items);
      setNextCursor(page.nextCursor);
      setState(page.items.length===0&&!cursor?'empty':'ready');
    }catch(cause){
      if(ticket!==searchSeq.current)return;
      setState('error');setSearchError(catalogErrorText(cause,language));
    }
  }
  function search(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const query=term.trim();
    if(!query||query.length>120){setSearchError(w.validation);return;}
    void runSearch(query);
  }
  function closeDetail(){
    ++detailSeq.current;
    detailAbort.current?.abort();
    setDetail(null);setDetailId(null);setDetailState('idle');
    setEditingEditionId(null);setReviewEditionId(null);setShowRights(false);
    setDetailError('');setEditing(false);setStale(false);
    setError('');setMessage('');
  }
  function clearEditor(){
    setError('');setMessage('');setStale(false);
    setEditing(false);setCreating(false);
  }
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(busy||!online||!secure)return;
    setError('');setMessage('');
    const input=kind==='authors'
      ?authorCreateSchema.safeParse({
        canonicalName:name, ...(sortName.trim()?{sortName}:{}),
        aliases:[],externalIds:[],
      })
      :workCreateSchema.safeParse({
        originalTitle:title,originalLanguage:newLanguage,
        ...(year.trim()?{firstPublicationYear:yearValue(year)}:{}),
        authors:[{authorId:primaryAuthorId.trim(),contribution:'author',sortOrder:0}],
        titles:[],editions:[],
      });
    if(!input.success){setError(w.validation);return;}
    setBusy(true);
    try{
      const result=kind==='authors'
        ?await createAdminAuthor(input.data as Parameters<typeof createAdminAuthor>[0])
        :await createAdminWork(input.data as Parameters<typeof createAdminWork>[0]);
      setCreating(false);setMessage(w.created);
      await loadDetail(result.id,true);
    }catch(cause){
      setError(catalogErrorText(cause,language));
      if(cause instanceof CatalogClientError&&cause.kind==='network'){
        // Response may be lost AFTER commit; do not attempt a write retry.
        setCreating(false);setMessage(w.conflictHelp);
      }
    }finally{setBusy(false);}
  }
  async function save(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!detail||busy||stale||!online||!secure)return;
    setError('');setMessage('');
    const id=detail.kind==='authors'?detail.value.author.id:detail.value.work.id;
    const version=detail.kind==='authors'
      ?detail.value.author.metadataVersion:detail.value.work.metadataVersion;
    try{
      if(detail.kind==='authors'){
        const input:Record<string,unknown>={expectedVersion:version};
        if(name.trim()!==detail.value.author.canonicalName)input.canonicalName=name;
        if(sortName.trim()!==detail.value.author.sortName)input.sortName=sortName;
        if(aliasesDirty)input.aliases=aliases.map(row=>({
          name:row.name,...(row.locale.trim()?{locale:row.locale.trim()}:{}),
        }));
        if(externalDirty)input.externalIds=externalIds;
        const parsed=canonicalAuthorMetadataPatchSchema.safeParse(input);
        if(!parsed.success){
          setError(Object.keys(input).length===1?w.noChanges:w.validation);return;
        }
        setBusy(true);
        await patchAdminAuthor(id,parsed.data);
      }else{
        if(detail.value.work.publicationStatus!=='draft'){setError(w.draftOnly);return;}
        const input:Record<string,unknown>={expectedVersion:version};
        if(title.trim()!==detail.value.work.originalTitle)input.originalTitle=title;
        const parsedYear=yearValue(year);
        if(parsedYear==='invalid'){setError(w.validation);return;}
        if(parsedYear!==detail.value.work.firstPublicationYear){
          input.firstPublicationYear=parsedYear;
        }
        const parsed=canonicalWorkMetadataPatchSchema.safeParse(input);
        if(!parsed.success){
          setError(Object.keys(input).length===1?w.noChanges:w.validation);return;
        }
        setBusy(true);
        await patchAdminWork(id,parsed.data);
      }
      setMessage(w.saved);
      await loadDetail(id,true);
    }catch(cause){
      setError(catalogErrorText(cause,language));
      if(cause instanceof CatalogClientError&&
        (cause.kind==='conflict'||cause.kind==='network')){
        setStale(true);setMessage(w.conflictHelp);
      }
    }finally{setBusy(false);}
  }
  const detailInfo=detail?.kind==='authors'?detail.value.author:
    detail?.kind==='works'?detail.value.work:null;
  const canEdit=detail!==null&&
    (detail.kind==='authors'||detail.value.work.publicationStatus==='draft');
  const formDisabled=!online||busy||stale;
  const editedEdition=detail?.kind==='works'&&editingEditionId
    ?detail.value.editions.find(item=>item.id===editingEditionId):undefined;
  const reviewedEdition=detail?.kind==='works'&&reviewEditionId
    ?detail.value.editions.find(item=>item.id===reviewEditionId):undefined;
  return <section className="folio-catalog" data-testid="admin-catalog-panel"
    aria-label={kind==='works'?(language==='tr'?'Eser kataloğu':'Works catalog'):
      (language==='tr'?'Yazar kataloğu':'Authors catalog')}>
    <p className="folio-catalog-intro">{w.info}</p>
    {!secure&&<div className="folio-state" data-testid="admin-catalog-insecure" role="status">
      <strong>{w.insecure}</strong>
      <p>{w.info}</p>
    </div>}
    {!online&&secure&&<p className="folio-catalog-alert" role="status">{w.offline}</p>}
    {(!secure||!online)&&<p><a href="/admin/settings">{w.settings}</a></p>}
    {secure&&<>
      <form className="folio-catalog-search" onSubmit={search} role="search">
        <label htmlFor={'folio-catalog-query-'+kind}>{w.query}</label>
        <div className="folio-catalog-inline">
          <input id={'folio-catalog-query-'+kind} type="search"
            maxLength={120} minLength={1} required
            value={term} autoComplete="off"
            onChange={event=>setTerm(event.target.value)}/>
          <button type="submit" disabled={!online||busy||state==='loading'}>{w.search}</button>
        </div>
        <p>{w.searchHelp}</p>
      </form>
      <div className="folio-catalog-tools">
        <button type="button" disabled={!online||busy} onClick={()=>{
          clearEditor();closeDetail();setCreating(true);
          setName('');setSortName('');setTitle('');setYear('');
          setPrimaryAuthorId('');setNewLanguage('tr');
        }}>{w.create}</button>
        <a href="/admin/settings">{w.settings}</a>
      </div>
      {searchError&&<p role="alert" className="folio-catalog-alert">{searchError}</p>}
      {state==='idle'&&<p role="status">{w.idle}</p>}
      {state==='loading'&&<p role="status">{w.loading}</p>}
      {state==='empty'&&<p role="status">{w.empty}</p>}
      {state==='ready'&&<section className="folio-catalog-results" aria-label={w.search}>
        <ul>
          {items.map(item=><li key={item.id}>
            <button type="button" onClick={()=>{clearEditor();void loadDetail(item.id);}}
              disabled={!online||busy}>
              <strong>{detailName(item)}</strong>
              <span>{'originalLanguage' in item?item.originalLanguage.toUpperCase():item.sortName}</span>
              <small>{item.id}</small>
            </button>
          </li>)}
        </ul>
        {nextCursor&&<button type="button" disabled={!online||busy}
          onClick={()=>{void runSearch(searched,nextCursor);}}>{w.more}</button>}
      </section>}
      {state==='error'&&<div className="folio-catalog-alert" role="alert">
        {searchError} <button type="button" onClick={()=>{void runSearch(searched);}}
          disabled={!online||busy}>{w.retry}</button>
      </div>}
      {creating&&<section className="folio-catalog-card" aria-label={w.create}>
        <h3>{w.create}</h3>
        <p>{w.editHelp}</p>
        <form onSubmit={event=>{void create(event);}} className="folio-catalog-fields">
          {kind==='authors'?<>
            <label htmlFor="folio-new-author-name">{w.name}</label>
            <input id="folio-new-author-name" autoComplete="off" required maxLength={240}
              value={name} onChange={event=>setName(event.target.value)}/>
            <label htmlFor="folio-new-author-sort">{w.sortName}</label>
            <input id="folio-new-author-sort" autoComplete="off" maxLength={240}
              value={sortName} onChange={event=>setSortName(event.target.value)}/>
          </>:<>
            <label htmlFor="folio-new-work-title">{w.original}</label>
            <input id="folio-new-work-title" autoComplete="off" required maxLength={600}
              value={title} onChange={event=>setTitle(event.target.value)}/>
            <label htmlFor="folio-new-work-language">{w.language}</label>
            <select id="folio-new-work-language" value={newLanguage}
              onChange={event=>setNewLanguage(event.target.value as 'tr'|'en')}>
              <option value="tr">TR</option><option value="en">EN</option>
            </select>
            <label htmlFor="folio-new-work-year">{w.year}</label>
            <input id="folio-new-work-year" inputMode="numeric" value={year}
              onChange={event=>setYear(event.target.value)} maxLength={5}/>
            <label htmlFor="folio-new-work-author">{w.primaryId}</label>
            <input id="folio-new-work-author" autoComplete="off" required
              pattern="[0-9a-fA-F-]{36}" maxLength={36}
              value={primaryAuthorId} onChange={event=>setPrimaryAuthorId(event.target.value)}/>
            <p>{w.primaryHelp}</p>
          </>}
          <div className="folio-catalog-actions">
            <button type="submit" disabled={!online||busy}>{w.createAction}</button>
            <button type="button" className="folio-catalog-secondary"
              onClick={clearEditor} disabled={busy}>{w.cancel}</button>
          </div>
        </form>
      </section>}
      {detailState==='loading'&&<p role="status">{w.detailLoading}</p>}
      {detailState==='error'&&detailId&&<div className="folio-catalog-alert" role="alert">
        {detailError} <button type="button" onClick={()=>{void loadDetail(detailId);}}
          disabled={!online||busy}>{w.retry}</button>
      </div>}
      {detail&&detailInfo&&<section className="folio-catalog-card"
        data-testid="admin-catalog-detail" aria-label={w.select}>
        <div className="folio-catalog-header">
          <div>
            <h3>{detail.kind==='authors'?detail.value.author.canonicalName:
              detail.value.work.originalTitle}</h3>
            <p><strong>{w.version}:</strong> {detailInfo.metadataVersion}
              {detail.kind==='works'&&<> · {w.status}: {translateStatus(detail.value.work.publicationStatus,language)}</>}</p>
          </div>
          <button type="button" className="folio-catalog-secondary"
            onClick={closeDetail} disabled={busy}>{w.close}</button>
        </div>
        {detail.kind==='works'?<>
          {online&&<AdminFolioCoverPreview detail={detail.value} language={language} theme={theme}/>}
          <p>{w.year}: {detail.value.work.firstPublicationYear??w.notAvailable}</p>
          <h4>{w.authors}</h4>
          <ul>{detail.value.authors.map(author=><li key={author.id}>
            {author.name} ({author.role}, {author.sortOrder})
          </li>)}</ul>
          <h4>{w.titles}</h4>
          <ul>{detail.value.titles.map(t=><li key={t.id}>
            {t.language.toUpperCase()} · {t.kind}: {t.title}
          </li>)}</ul>
          <h4>{w.editions}</h4>
          {detail.value.editions.length===0?<p>{w.notAvailable}</p>:
            <ul>{detail.value.editions.map(edition=><li key={edition.id}>
              <strong>{edition.label}</strong> · {edition.language.toUpperCase()} · {translateStatus(edition.status,language)}
              {edition.identifiers.length>0&&<p>{w.identifiers}: {edition.identifiers.map(i=>i.kind+' '+i.value).join(' · ')}</p>}
              {edition.contributors.length>0&&<p>{w.contributors}: {edition.contributors.map(c=>c.role+' '+c.authorId).join(' · ')}</p>}
              {detail.value.work.publicationStatus==='draft'&&
                edition.status==='draft'&&<button type="button"
                  disabled={busy||!online||editing}
                  onClick={()=>{
                    setEditingEditionId(edition.id);setReviewEditionId(null);
                    setError('');setMessage('');setStale(false);
                  }}>{w.editEdition}</button>}
              <button type="button" className="folio-catalog-secondary"
                aria-expanded={reviewEditionId===edition.id}
                disabled={busy||!online||editing||!!editingEditionId}
                onClick={()=>setReviewEditionId(current=>current===edition.id?null:edition.id)}>
                {w.reviewRevision}</button>
            </li>)}</ul>}
          <button type="button" className="folio-catalog-secondary"
            aria-expanded={showRights} disabled={!online||busy||editing||!!editingEditionId}
            onClick={()=>setShowRights(current=>!current)}>{w.viewRights}</button>
        </>:<>
          <p>{w.sortName}: {detail.value.author.sortName}</p>
          <h4>{w.aliases}</h4>
          {detail.value.aliases.length===0?<p>{w.notAvailable}</p>:
            <ul>{detail.value.aliases.map(alias=><li key={alias.id}>
              {alias.name}{alias.locale?' ('+alias.locale+')':''}
            </li>)}</ul>}
          <h4>{w.external}</h4>
          {detail.value.externalIds.length===0?<p>{w.notAvailable}</p>:
            <ul>{detail.value.externalIds.map(source=><li key={source.source+':'+source.externalId}>
              {source.source}: {source.externalId}
            </li>)}</ul>}
        </>}
        <p>{w.editHelp}</p>
        {canEdit&&!editing&&!editingEditionId&&<button type="button" onClick={()=>{setEditing(true);setError('');setMessage('');}}
          disabled={busy||!online}>{w.edit}</button>}
        {!canEdit&&<p role="status">{w.draftOnly}</p>}
        {editing&&<form className="folio-catalog-fields"
          aria-label={w.edit} onSubmit={event=>{void save(event);}}>
          {detail.kind==='authors'?<>
            <label htmlFor="folio-edit-author-name">{w.name}</label>
            <input id="folio-edit-author-name" value={name} maxLength={240}
              required disabled={formDisabled} onChange={event=>setName(event.target.value)}/>
            <label htmlFor="folio-edit-author-sort">{w.sortName}</label>
            <input id="folio-edit-author-sort" value={sortName} maxLength={240}
              required disabled={formDisabled} onChange={event=>setSortName(event.target.value)}/>
            <fieldset>
              <legend>{w.aliases}</legend>
              {aliases.length>30?<p>{w.limit}</p>:<>
                {aliases.map((row,index)=><div className="folio-catalog-relation" key={index}>
                  <input aria-label={w.alias+' '+(index+1)} required maxLength={240}
                    value={row.name} disabled={formDisabled}
                    onChange={event=>{setAliases(old=>old.map((v,i)=>i===index?{
                      ...v,name:event.target.value}:v));setAliasesDirty(true);}}/>
                  <input aria-label={w.locale+' '+(index+1)} maxLength={12}
                    value={row.locale} disabled={formDisabled}
                    onChange={event=>{setAliases(old=>old.map((v,i)=>i===index?{
                      ...v,locale:event.target.value}:v));setAliasesDirty(true);}}/>
                  <button type="button" className="folio-catalog-secondary"
                    aria-label={w.remove+' '+w.alias+' '+(index+1)} disabled={formDisabled}
                    onClick={()=>{setAliases(old=>old.filter((_,i)=>i!==index));setAliasesDirty(true);}}>{w.remove}</button>
                </div>)}
                <button type="button" className="folio-catalog-secondary"
                  disabled={formDisabled||aliases.length>=30}
                  onClick={()=>{setAliases(old=>[...old,{name:'',locale:''}]);setAliasesDirty(true);}}>
                  {w.addAlias}
                </button>
              </>}
            </fieldset>
            <fieldset><legend>{w.external}</legend>
              {externalIds.length>30?<p>{w.limit}</p>:<>
                {externalIds.map((row,index)=><div className="folio-catalog-relation" key={index}>
                  <input aria-label={w.source+' '+(index+1)} required maxLength={80}
                    value={row.source} disabled={formDisabled}
                    onChange={event=>{setExternalIds(old=>old.map((v,i)=>i===index?{
                      ...v,source:event.target.value}:v));setExternalDirty(true);}}/>
                  <input aria-label={w.externalId+' '+(index+1)} required maxLength={400}
                    value={row.externalId} disabled={formDisabled}
                    onChange={event=>{setExternalIds(old=>old.map((v,i)=>i===index?{
                      ...v,externalId:event.target.value}:v));setExternalDirty(true);}}/>
                  <button type="button" className="folio-catalog-secondary"
                    aria-label={w.remove+' '+w.external+' '+(index+1)} disabled={formDisabled}
                    onClick={()=>{setExternalIds(old=>old.filter((_,i)=>i!==index));setExternalDirty(true);}}>{w.remove}</button>
                </div>)}
                <button type="button" className="folio-catalog-secondary"
                  disabled={formDisabled||externalIds.length>=30}
                  onClick={()=>{setExternalIds(old=>[...old,{source:'',externalId:''}]);setExternalDirty(true);}}>
                  {w.addSource}
                </button>
              </>}
            </fieldset>
          </>:<>
            <label htmlFor="folio-edit-work-title">{w.original}</label>
            <input id="folio-edit-work-title" value={title} required
              maxLength={600} disabled={formDisabled}
              onChange={event=>setTitle(event.target.value)}/>
            <label htmlFor="folio-edit-work-year">{w.year}</label>
            <input id="folio-edit-work-year" inputMode="numeric" maxLength={5}
              value={year} disabled={formDisabled}
              onChange={event=>setYear(event.target.value)}/>
          </>}
          <p>{w.version}: {detailInfo.metadataVersion}</p>
          {stale&&<p role="alert">{w.conflictHelp}</p>}
          <div className="folio-catalog-actions">
            <button type="submit" disabled={formDisabled}>{w.save}</button>
            <button type="button" className="folio-catalog-secondary"
              onClick={()=>{setEditing(false);setError('');setStale(false);}}
              disabled={busy}>{w.cancel}</button>
            {stale&&<button type="button" disabled={!online||busy}
              onClick={()=>{void loadDetail(detailId!);}}>{w.reload}</button>}
          </div>
        </form>}
      </section>}
      {showRights&&detail?.kind==='works'&&
        <AdminRightsLedgerPanel key={detail.value.work.id}
          workId={detail.value.work.id} language={language}
          online={online&&!busy}/>
      }
      {reviewedEdition&&detail?.kind==='works'&&
        <AdminRevisionDiffPanel
          key={reviewedEdition.id} workId={detail.value.work.id}
          editionId={reviewedEdition.id} language={language}
          online={online&&!busy}/>
      }
      {editedEdition&&detail?.kind==='works'&&
        <AdminEditionMetadataEditor
          key={editedEdition.id+':'+detail.value.work.metadataVersion}
          edition={editedEdition} workId={detail.value.work.id}
          parentVersion={detail.value.work.metadataVersion}
          language={language} online={online&&!busy}
          onReload={()=>{
            setMessage(w.saved);
            void loadDetail(detail.value.work.id,true);
          }}
          onCancel={()=>setEditingEditionId(null)}
        />}
      {detail?.kind==='works'&&detail.value.work.publicationStatus==='draft'&&
        !editing&&!stale&&!editingEditionId&&<AdminWorkRelations
          key={detail.value.work.id+':'+detail.value.work.metadataVersion}
          workId={detail.value.work.id}
          version={detail.value.work.metadataVersion}
          online={online&&!busy} language={language}
          onReload={()=>{
            setMessage(w.saved);
            void loadDetail(detail.value.work.id,true);
          }}/>
      }
      {busy&&<p role="status">{w.saving}</p>}
      {message&&<p className="folio-catalog-notice" role="status">{message}</p>}
      {error&&<p className="folio-catalog-alert" role="alert">{error}</p>}
    </>}
  </section>;
}
