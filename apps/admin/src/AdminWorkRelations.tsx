import {useEffect,useState} from 'react';
import type {FormEvent} from 'react';
import type {AdminCatalogWorkDetail} from '@folio/contracts';
import {
  adminCatalogEditionAppendSchema,adminCatalogTitleAppendSchema,
  adminCatalogWorkAuthorAppendSchema,
  adminCatalogTitleMetadataPatchSchema,adminCatalogWorkAuthorMetadataPatchSchema,
} from '@folio/contracts';
import {
  appendAdminWorkEdition,appendAdminWorkTitle,appendAdminWorkAuthor,
  removeAdminWorkTitle,removeAdminWorkAuthor,
  patchAdminWorkTitle,patchAdminWorkAuthorLink,removeAdminEmptyDraftEdition,
  CatalogClientError,catalogErrorText,
} from './admin-catalog-client.js';

type Language='tr'|'en';
type Mode='edition'|'title'|'author';
type Identifier={kind:'isbn-10'|'isbn-13'|'other';value:string};
type Contributor={authorId:string;role:'author'|'translator'|'editor'|'illustrator';sortOrder:string};
interface Props{
  workId:string;
  version:number;
  authors:AdminCatalogWorkDetail['authors'];
  titles:AdminCatalogWorkDetail['titles'];
  editions:AdminCatalogWorkDetail['editions'];
  language:Language;
  online:boolean;
  onReload:()=>void;
}
const copy={
  tr:{
    heading:'Taslak eser ilişkileri',notice:'Yalnız metadata eklenir; içerik dosyası, telif onayı veya katalog yayını yapılmaz.',
    edition:'Baskı ekle',title:'Alternatif başlık ekle',author:'Yazar bağla',
    label:'Baskı etiketi',language:'Dil',publisher:'Yayınevi (isteğe bağlı)',
    identifier:'Tanımlayıcı',identifierKind:'Tür',identifierValue:'Değer',
    addIdentifier:'Tanımlayıcı ekle',contributors:'Katkıda bulunanlar',
    addContributor:'Katkı veren ekle',remove:'Kaldır',
    authorId:'Kanonik yazar UUID',contribution:'Katkı türü',order:'Sıra',
    role:'Baskı katkı görevi',alternateTitle:'Başlık',titleKind:'Başlık türü',
    alternate:'Alternatif',translation:'Çeviri başlığı (metin değil)',
    save:'Sürüm kontrolüyle ekle',cancel:'Vazgeç',
    created:'Sunucu ilişki eklemeyi onayladı; güncel eser okunuyor.',
    loading:'İlişki sunucuda doğrulanıp kaydediliyor…',
    validation:'Alanları, UUID ve sıra değerlerini kontrol edin. İstek gönderilmedi.',
    stale:'Kayıt değişmiş olabilir. Otomatik tekrar yok; önce son sürümü inceleyin.',
    reload:'Güncel eseri yeniden yükle',version:'Beklenen metadata sürümü',
    tooMany:'Sınır aşıldı. Yeni kayıt eklenemiyor.',
    unlinkTitle:'Alternatif başlığı kaldır',unlinkAuthor:'Eserden yazar bağını kaldır',
    unlinkEdition:'Boş taslak baskıyı kaldır',editTitle:'Alternatif başlığı düzenle',
    editAuthor:'Yazarın rolünü/sırasını düzenle',saveEdit:'Değişikliği sürüm kontrolüyle kaydet',
    editionRemoveWarning:'Yalnız içerik revizyonu ve hak kaydı olmayan taslak baskı kaldırılır; kaynak ve diğer baskılar korunur.',
    unlinkWarning:'Yalnız eser ilişkisi kaldırılır. Kanonik yazar veya kitap içeriği silinmez.',
    confirmUnlink:'İlişkiyi kaldırmayı onayla',cancelUnlink:'Vazgeç',
    unlinkPending:'İlişki sunucuda güvenli biçimde kaldırılıyor…',
    unlinked:'Sunucu ilişkiyi kaldırdı; eser yeniden yükleniyor.',
  },
  en:{
    heading:'Draft work relationships',notice:'Adds metadata only. No text, copyright approval or public catalog publication.',
    edition:'Add edition',title:'Add alternate title',author:'Link author',
    label:'Edition label',language:'Language',publisher:'Publisher (optional)',
    identifier:'Identifier',identifierKind:'Kind',identifierValue:'Value',
    addIdentifier:'Add identifier',contributors:'Contributors',
    addContributor:'Add contributor',remove:'Remove',
    authorId:'Canonical author UUID',contribution:'Contribution',order:'Order',
    role:'Edition contributor role',alternateTitle:'Title',titleKind:'Title kind',
    alternate:'Alternate',translation:'Translation title (not text)',
    save:'Add with version check',cancel:'Cancel',
    created:'The server confirmed this relationship; loading the latest work.',
    loading:'Validating and saving the relation on the server…',
    validation:'Review inputs, UUIDs and order. Nothing was sent.',
    stale:'The record may have changed. No automatic retry; review the latest revision.',
    reload:'Reload current work',version:'Expected metadata version',
    tooMany:'Limit reached. Cannot add another row.',
    unlinkTitle:'Unlink alternate title',unlinkAuthor:'Unlink work author',
    unlinkEdition:'Remove empty draft edition',editTitle:'Edit alternate title',
    editAuthor:'Edit author role/order',saveEdit:'Save versioned change',
    editionRemoveWarning:'Only DRAFT editions without source revisions or rights may be removed; all other content is retained.',
    unlinkWarning:'Only the work relation is removed. The canonical author and book content remain intact.',
    confirmUnlink:'Confirm unlink',cancelUnlink:'Cancel',
    unlinkPending:'Removing the draft relation on the server…',
    unlinked:'The server removed the relation; reloading the work.',
  },
} as const;
function order(raw:string):number|null{
  if(!/^(0|[1-9]\d{0,4})$/.test(raw))return null;
  const n=Number(raw);
  return n<=10000?n:null;
}

/** Only mounted after a live, authorized, versioned DRAFT GET response.
 * Every child POST re-verifies TLS/session/MFA/role and CSRF on the server. */
export function AdminWorkRelations({workId,version,authors,titles,editions,language,online,onReload}:Props){
  const w=copy[language];
  const [mode,setMode]=useState<Mode|null>(null);
  const [removeTarget,setRemoveTarget]=useState<{kind:'title'|'author'|'edition';id:string}|null>(null);
  const [editTarget,setEditTarget]=useState<{kind:'title'|'author';id:string}|null>(null);
  const [editionLanguage,setEditionLanguage]=useState<'tr'|'en'>('en');
  const [editionLabel,setEditionLabel]=useState('');
  const [publisher,setPublisher]=useState('');
  const [identifiers,setIdentifiers]=useState<Identifier[]>([]);
  const [contributors,setContributors]=useState<Contributor[]>([]);
  const [alternateLanguage,setAlternateLanguage]=useState<'tr'|'en'>('en');
  const [alternateTitle,setAlternateTitle]=useState('');
  const [titleKind,setTitleKind]=useState<'alternate'|'translation'>('alternate');
  const [authorId,setAuthorId]=useState('');
  const [contribution,setContribution]=useState<'author'|'co-author'|'editor'>('co-author');
  const [authorOrder,setAuthorOrder]=useState('1');
  const [busy,setBusy]=useState(false);
  const [stale,setStale]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [connected,setConnected]=useState(online);

  useEffect(()=>{setConnected(online);},[online]);
  const disabled=busy||stale||!connected;
  function start(next:Mode){
    if(busy||!online)return;
    setMode(next);setRemoveTarget(null);setEditTarget(null);setStale(false);setError('');setNotice('');
    setEditionLanguage('en');setEditionLabel('');setPublisher('');
    setIdentifiers([]);setContributors([]);
    setAlternateLanguage('en');setAlternateTitle('');setTitleKind('alternate');
    setAuthorId('');setContribution('co-author');setAuthorOrder('1');
  }
  function startEdit(kind:'title'|'author',id:string){
    if(disabled||mode||removeTarget)return;
    setMode(null);setRemoveTarget(null);setEditTarget({kind,id});
    setStale(false);setError('');setNotice('');
    if(kind==='title'){
      const item=titles.find(row=>row.id===id);
      if(!item||item.kind==='original'){setEditTarget(null);return;}
      setAlternateTitle(item.title);setAlternateLanguage(item.language);
      setTitleKind(item.kind);
    }else{
      const item=authors.find(row=>row.id===id);
      if(!item){setEditTarget(null);return;}
      setContribution(item.role);setAuthorOrder(String(item.sortOrder));
    }
  }
  async function submitEdit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(disabled||!editTarget)return;
    let task:()=>Promise<{metadataVersion:number}>;
    if(editTarget.kind==='title'){
      const data=adminCatalogTitleMetadataPatchSchema.safeParse({
        expectedVersion:version,title:alternateTitle,
        language:alternateLanguage,kind:titleKind,
      });
      if(!data.success){setError(w.validation);return;}
      task=()=>patchAdminWorkTitle(workId,editTarget.id,data.data);
    }else{
      const data=adminCatalogWorkAuthorMetadataPatchSchema.safeParse({
        expectedVersion:version,contribution,sortOrder:order(authorOrder),
      });
      if(!data.success){setError(w.validation);return;}
      task=()=>patchAdminWorkAuthorLink(workId,editTarget.id,data.data);
    }
    setBusy(true);setError('');setNotice('');
    try{
      const result=await task();
      if(result.metadataVersion!==version+1)throw new CatalogClientError('unexpected');
      setEditTarget(null);setNotice(w.created);onReload();
    }catch(cause){
      setError(catalogErrorText(cause,language));
      if(cause instanceof CatalogClientError&&
        (cause.kind==='conflict'||cause.kind==='network')){
        setStale(true);setNotice(w.stale);
      }
    }finally{setBusy(false);}
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!online||busy||stale||!mode)return;
    let task:()=>Promise<{metadataVersion:number}>;
    if(mode==='edition'){
      const parsed=adminCatalogEditionAppendSchema.safeParse({
        expectedVersion:version,
        language:editionLanguage,label:editionLabel,
        ...(publisher.trim()?{publisher}:{}),
        identifiers,contributors:contributors.map(row=>({
          authorId:row.authorId,role:row.role,sortOrder:order(row.sortOrder),
        })),
      });
      if(!parsed.success){setError(w.validation);return;}
      task=()=>appendAdminWorkEdition(workId,parsed.data);
    }else if(mode==='title'){
      const parsed=adminCatalogTitleAppendSchema.safeParse({
        expectedVersion:version,language:alternateLanguage,
        title:alternateTitle,kind:titleKind,
      });
      if(!parsed.success){setError(w.validation);return;}
      task=()=>appendAdminWorkTitle(workId,parsed.data);
    }else{
      const parsed=adminCatalogWorkAuthorAppendSchema.safeParse({
        expectedVersion:version,authorId,
        contribution,sortOrder:order(authorOrder),
      });
      if(!parsed.success){setError(w.validation);return;}
      task=()=>appendAdminWorkAuthor(workId,parsed.data);
    }
    setError('');setNotice('');setBusy(true);
    try{
      const result=await task();
      if(result.metadataVersion!==version+1){
        throw new CatalogClientError('unexpected');
      }
      // The display is only updated after a separate verified GET, never a
      // client-side optimistic object insertion.
      setNotice(w.created);
      onReload();
    }catch(cause){
      setError(catalogErrorText(cause,language));
      if(cause instanceof CatalogClientError&&
        (cause.kind==='conflict'||cause.kind==='network')){
        // Transport failure is ambiguous: backend may already have committed.
        // Retry is forbidden until an explicit fresh authenticated GET.
        setStale(true);setNotice(w.stale);
      }
    }finally{setBusy(false);}
  }
  async function confirmRemove(){
    if(!removeTarget||!online||busy||stale||mode||editTarget)return;
    setBusy(true);setError('');setNotice('');
    try{
      const result=removeTarget.kind==='title'
        ?await removeAdminWorkTitle(workId,removeTarget.id,{expectedVersion:version})
        :removeTarget.kind==='author'
          ?await removeAdminWorkAuthor(workId,removeTarget.id,{expectedVersion:version})
          :await removeAdminEmptyDraftEdition(workId,removeTarget.id,{expectedVersion:version});
      if(result.metadataVersion!==version+1){
        throw new CatalogClientError('unexpected');
      }
      setRemoveTarget(null);
      setNotice(w.unlinked);
      onReload();
    }catch(cause){
      setError(catalogErrorText(cause,language));
      if(cause instanceof CatalogClientError&&
        (cause.kind==='conflict'||cause.kind==='network')){
        setStale(true);setNotice(w.stale);
      }
    }finally{setBusy(false);}
  }
  return <section className="folio-catalog-card folio-catalog-relations"
    data-testid="admin-work-relations" aria-label={w.heading}>
    <h3>{w.heading}</h3>
    <p>{w.notice}</p>
    <p>{w.version}: <strong>{version}</strong></p>
    {!mode&&!editTarget&&<div className="folio-catalog-actions">
      <button type="button" disabled={!online||busy}
        onClick={()=>start('edition')}>{w.edition}</button>
      <button type="button" disabled={!online||busy}
        onClick={()=>start('title')}>{w.title}</button>
      <button type="button" disabled={!online||busy}
        onClick={()=>start('author')}>{w.author}</button>
    </div>}
    {mode&&<form className="folio-catalog-fields" onSubmit={event=>{void submit(event);}}
      aria-label={mode==='edition'?w.edition:mode==='title'?w.title:w.author}>
      <h4>{mode==='edition'?w.edition:mode==='title'?w.title:w.author}</h4>
      {mode==='edition'&&<>
        <label htmlFor="folio-relation-label">{w.label}</label>
        <input id="folio-relation-label" maxLength={400} required
          value={editionLabel} disabled={disabled}
          onChange={e=>setEditionLabel(e.target.value)}/>
        <label htmlFor="folio-relation-lang">{w.language}</label>
        <select id="folio-relation-lang" value={editionLanguage} disabled={disabled}
          onChange={e=>setEditionLanguage(e.target.value as 'tr'|'en')}>
          <option value="tr">TR</option><option value="en">EN</option>
        </select>
        <label htmlFor="folio-relation-publisher">{w.publisher}</label>
        <input id="folio-relation-publisher" value={publisher} disabled={disabled}
          maxLength={240} onChange={e=>setPublisher(e.target.value)}/>
        <fieldset><legend>{w.identifier}</legend>
          {identifiers.map((item,index)=><div className="folio-catalog-relation" key={index}>
            <select aria-label={w.identifierKind+' '+(index+1)}
              value={item.kind} disabled={disabled}
              onChange={e=>setIdentifiers(list=>list.map((row,i)=>i===index?{
                ...row,kind:e.target.value as Identifier['kind']}:row))}>
              <option value="isbn-10">ISBN-10</option>
              <option value="isbn-13">ISBN-13</option>
              <option value="other">{w.identifier}</option>
            </select>
            <input aria-label={w.identifierValue+' '+(index+1)}
              value={item.value} maxLength={150} required disabled={disabled}
              onChange={e=>setIdentifiers(list=>list.map((row,i)=>i===index?{
                ...row,value:e.target.value}:row))}/>
            <button type="button" className="folio-catalog-secondary"
              aria-label={w.remove+' '+w.identifier+' '+(index+1)} disabled={disabled}
              onClick={()=>setIdentifiers(list=>list.filter((_,i)=>i!==index))}>{w.remove}</button>
          </div>)}
          <button type="button" className="folio-catalog-secondary"
            disabled={disabled||identifiers.length>=30}
            onClick={()=>setIdentifiers(list=>[...list,{kind:'isbn-13',value:''}])}>
            {w.addIdentifier}</button>
        </fieldset>
        <fieldset><legend>{w.contributors}</legend>
          {contributors.map((row,index)=><div className="folio-catalog-relation"
            key={index}>
            <input aria-label={w.authorId+' '+(index+1)} required
              minLength={36} maxLength={36} value={row.authorId} disabled={disabled}
              onChange={e=>setContributors(list=>list.map((item,i)=>i===index?{
                ...item,authorId:e.target.value}:item))}/>
            <select aria-label={w.role+' '+(index+1)} disabled={disabled}
              value={row.role}
              onChange={e=>setContributors(list=>list.map((item,i)=>i===index?{
                ...item,role:e.target.value as Contributor['role']}:item))}>
              {(['author','translator','editor','illustrator'] as const).map(role=>
                <option key={role} value={role}>{role}</option>)}
            </select>
            <input aria-label={w.order+' '+(index+1)} inputMode="numeric" required
              value={row.sortOrder} disabled={disabled} maxLength={5}
              onChange={e=>setContributors(list=>list.map((item,i)=>i===index?{
                ...item,sortOrder:e.target.value}:item))}/>
            <button type="button" className="folio-catalog-secondary"
              aria-label={w.remove+' '+w.contributors+' '+(index+1)}
              disabled={disabled}
              onClick={()=>setContributors(list=>list.filter((_,i)=>i!==index))}>
              {w.remove}</button>
          </div>)}
          <button type="button" className="folio-catalog-secondary"
            disabled={disabled||contributors.length>=50}
            onClick={()=>setContributors(list=>[...list,{
              authorId:'',role:'translator',sortOrder:'0',
            }])}>{w.addContributor}</button>
        </fieldset>
      </>}
      {mode==='title'&&<>
        <label htmlFor="folio-relation-alt-title">{w.alternateTitle}</label>
        <input id="folio-relation-alt-title" required maxLength={600}
          value={alternateTitle} disabled={disabled}
          onChange={e=>setAlternateTitle(e.target.value)}/>
        <label htmlFor="folio-relation-alt-lang">{w.language}</label>
        <select id="folio-relation-alt-lang" value={alternateLanguage}
          disabled={disabled}
          onChange={e=>setAlternateLanguage(e.target.value as 'tr'|'en')}>
          <option value="tr">TR</option><option value="en">EN</option>
        </select>
        <label htmlFor="folio-relation-title-kind">{w.titleKind}</label>
        <select id="folio-relation-title-kind" value={titleKind} disabled={disabled}
          onChange={e=>setTitleKind(e.target.value as 'translation'|'alternate')}>
          <option value="alternate">{w.alternate}</option>
          <option value="translation">{w.translation}</option>
        </select>
      </>}
      {mode==='author'&&<>
        <label htmlFor="folio-relation-author-id">{w.authorId}</label>
        <input id="folio-relation-author-id" value={authorId} required
          maxLength={36} minLength={36} disabled={disabled}
          onChange={e=>setAuthorId(e.target.value)}/>
        <label htmlFor="folio-relation-author-role">{w.contribution}</label>
        <select id="folio-relation-author-role" value={contribution} disabled={disabled}
          onChange={e=>setContribution(e.target.value as typeof contribution)}>
          <option value="author">author</option>
          <option value="co-author">co-author</option>
          <option value="editor">editor</option>
        </select>
        <label htmlFor="folio-relation-author-order">{w.order}</label>
        <input id="folio-relation-author-order" value={authorOrder}
          maxLength={5} inputMode="numeric" required disabled={disabled}
          onChange={e=>setAuthorOrder(e.target.value)}/>
      </>}
      <div className="folio-catalog-actions">
        <button type="submit" disabled={disabled}>{w.save}</button>
        <button type="button" className="folio-catalog-secondary"
          onClick={()=>{setMode(null);setStale(false);setNotice('');setError('');}}
          disabled={busy}>{w.cancel}</button>
        {stale&&<button type="button" disabled={busy||!online}
          onClick={onReload}>{w.reload}</button>}
      </div>
    </form>}
    {editTarget&&<form className="folio-catalog-fields"
      data-testid="admin-work-relation-edit"
      aria-label={editTarget.kind==='title'?w.editTitle:w.editAuthor}
      onSubmit={event=>{void submitEdit(event);}}>
      <h4>{editTarget.kind==='title'?w.editTitle:w.editAuthor}</h4>
      {editTarget.kind==='title'?<>
        <label htmlFor="folio-relation-edit-title">{w.alternateTitle}</label>
        <input id="folio-relation-edit-title" required maxLength={600}
          value={alternateTitle} disabled={disabled}
          onChange={event=>setAlternateTitle(event.target.value)}/>
        <label htmlFor="folio-relation-edit-language">{w.language}</label>
        <select id="folio-relation-edit-language" value={alternateLanguage}
          disabled={disabled}
          onChange={event=>setAlternateLanguage(event.target.value as 'tr'|'en')}>
          <option value="tr">TR</option><option value="en">EN</option>
        </select>
        <label htmlFor="folio-relation-edit-kind">{w.titleKind}</label>
        <select id="folio-relation-edit-kind" value={titleKind} disabled={disabled}
          onChange={event=>setTitleKind(event.target.value as 'alternate'|'translation')}>
          <option value="alternate">{w.alternate}</option>
          <option value="translation">{w.translation}</option>
        </select>
      </>:<>
        <label htmlFor="folio-relation-edit-role">{w.contribution}</label>
        <select id="folio-relation-edit-role" value={contribution} disabled={disabled}
          onChange={event=>setContribution(event.target.value as typeof contribution)}>
          <option value="author">author</option>
          <option value="co-author">co-author</option>
          <option value="editor">editor</option>
        </select>
        <label htmlFor="folio-relation-edit-order">{w.order}</label>
        <input id="folio-relation-edit-order" inputMode="numeric" required maxLength={5}
          value={authorOrder} disabled={disabled}
          onChange={event=>setAuthorOrder(event.target.value)}/>
      </>}
      <div className="folio-catalog-actions">
        <button type="submit" disabled={disabled}>{w.saveEdit}</button>
        <button type="button" className="folio-catalog-secondary" disabled={busy}
          onClick={()=>{setEditTarget(null);setError('');setStale(false);}}>
          {w.cancel}</button>
        {stale&&<button type="button" disabled={busy||!online}
          onClick={onReload}>{w.reload}</button>}
      </div>
    </form>}
    {!mode&&!editTarget&&<section data-testid="admin-work-relation-unlink" aria-label={w.unlinkWarning}>
      <p>{w.unlinkWarning}</p>
      <ul>{titles.filter(item=>item.kind!=='original').map(item=><li key={item.id}>
        {item.title} ({item.language.toUpperCase()})
        <button type="button" className="folio-catalog-secondary"
          aria-label={w.editTitle+': '+item.title}
          disabled={disabled||removeTarget!==null}
          onClick={()=>startEdit('title',item.id)}>{w.editTitle}</button>
        <button type="button" className="folio-catalog-secondary"
          aria-label={w.unlinkTitle+': '+item.title}
          disabled={disabled||removeTarget!==null}
          onClick={()=>{setRemoveTarget({kind:'title',id:item.id});setError('');setNotice('');}}>
          {w.unlinkTitle}</button>
      </li>)}</ul>
      <ul>{authors.filter(item=>authors.some(other=>other.id!==item.id&&
        (other.role==='author'||other.role==='co-author'))).map(item=><li key={item.id}>
        {item.name} ({item.role})
        <button type="button" className="folio-catalog-secondary"
          aria-label={w.editAuthor+': '+item.name}
          disabled={disabled||removeTarget!==null}
          onClick={()=>startEdit('author',item.id)}>{w.editAuthor}</button>
        <button type="button" className="folio-catalog-secondary"
          aria-label={w.unlinkAuthor+': '+item.name}
          disabled={disabled||removeTarget!==null}
          onClick={()=>{setRemoveTarget({kind:'author',id:item.id});setError('');setNotice('');}}>
          {w.unlinkAuthor}</button>
      </li>)}</ul>
      {editions.some(row=>row.status==='draft')&&<>
        <p>{w.editionRemoveWarning}</p>
        <ul>{editions.filter(row=>row.status==='draft').map(row=><li key={row.id}>
          {row.label} ({row.language.toUpperCase()})
          <button type="button" className="folio-catalog-secondary"
            aria-label={w.unlinkEdition+': '+row.label}
            disabled={disabled||removeTarget!==null}
            onClick={()=>{setRemoveTarget({kind:'edition',id:row.id});
              setError('');setNotice('');}}>{w.unlinkEdition}</button>
        </li>)}</ul>
      </>}
      {removeTarget&&<div className="folio-catalog-actions"
        data-testid="admin-work-relation-unlink-confirm">
        <button type="button" disabled={disabled}
          onClick={()=>{void confirmRemove();}}>{w.confirmUnlink}</button>
        <button type="button" className="folio-catalog-secondary"
          disabled={busy} onClick={()=>setRemoveTarget(null)}>{w.cancelUnlink}</button>
      </div>}
      {stale&&<button type="button" className="folio-catalog-secondary"
        disabled={busy||!online} onClick={onReload}>{w.reload}</button>}
    </section>}
    {busy&&<p role="status">{removeTarget?w.unlinkPending:w.loading}</p>}
    {notice&&<p className="folio-catalog-notice" role="status">{notice}</p>}
    {error&&<p className="folio-catalog-alert" role="alert">{error}</p>}
  </section>;
}
