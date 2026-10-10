import {useState} from 'react';
import type {FormEvent} from 'react';
import {adminCatalogEditionMetadataPatchSchema} from '@folio/contracts';
import type {AdminCatalogWorkDetail} from '@folio/contracts';
import {
  CatalogClientError,catalogErrorText,patchAdminEdition,
} from './admin-catalog-client.js';

type Language='tr'|'en';
type Edition=AdminCatalogWorkDetail['editions'][number];
type Identifier={kind:'isbn-10'|'isbn-13'|'other';value:string};
type Contributor={authorId:string;role:'author'|'translator'|'editor'|'illustrator';sortOrder:string};
const copy={
  tr:{
    title:'Taslak baskıyı düzenle',info:'Baskı UUID, dil, kaynak metin, yayın ve hak onayı burada değişmez.',
    label:'Baskı etiketi',publisher:'Yayınevi (boş bırakılırsa temizlenir)',
    identifier:'Tanımlayıcılar',kind:'Tanımlayıcı türü',value:'Tanımlayıcı değeri',
    addIdentifier:'ISBN / tanımlayıcı ekle',contributors:'Katkı verenler',
    authorId:'Kanonik yazar UUID',role:'Görev',order:'Sıra',
    addContributor:'Katkı veren ekle',remove:'Kaldır',
    save:'Sürüm kontrollü kaydet',cancel:'Vazgeç',
    unchanged:'Değiştirilen alan yok. Sunucuya yazma isteği gönderilmedi.',
    validation:'Geçersiz metadata. Alanları ve UUID değerlerini kontrol edin.',
    busy:'Sunucu baskı değişikliğini doğruluyor…',
    success:'Sunucu baskı değişikliğini doğruladı. Güncel kanonik eser yükleniyor.',
    stale:'Sürüm değişmiş veya ağ cevabı kaybolmuş olabilir. Kaydı tekrar göndermeden önce en güncel sürümü yükleyin.',
    reload:'Güncel baskıyı sunucudan yükle',version:'Beklenen eser sürümü',
    limit:'Bu baskının tüm ilişkileri formun güvenli değiştirme sınırından fazla; bu liste yalnız okunabilir.',
    status:'Baskı durumu',
  },
  en:{
    title:'Edit draft edition',info:'Edition UUID, language, source text, publication and rights approval cannot change here.',
    label:'Edition label',publisher:'Publisher (blank clears)',
    identifier:'Identifiers',kind:'Identifier kind',value:'Identifier value',
    addIdentifier:'Add ISBN / identifier',contributors:'Contributors',
    authorId:'Canonical author UUID',role:'Role',order:'Order',
    addContributor:'Add contributor',remove:'Remove',
    save:'Save with version check',cancel:'Cancel',
    unchanged:'No metadata changed. No write was sent to the server.',
    validation:'Invalid metadata. Review fields and UUID values.',
    busy:'Server is validating the edition change…',
    success:'Server confirmed this edition edit. Reloading the current canonical work.',
    stale:'The revision changed or the response was lost. Load the latest server revision before attempting another write.',
    reload:'Reload current edition',version:'Expected work version',
    limit:'Too many related records for safe list editing. This list is read-only.',
    status:'Edition status',
  },
} as const;
function parsedOrder(value:string):number|null{
  if(!/^(0|[1-9]\d{0,4})$/.test(value))return null;
  const n=Number(value);
  return n<=10000?n:null;
}

export function AdminEditionMetadataEditor({
  edition,workId,parentVersion,language,online,onReload,onCancel,
}:{
  edition:Edition;workId:string;parentVersion:number;
  language:Language;online:boolean;
  onReload:()=>void;onCancel:()=>void;
}){
  const w=copy[language];
  const [label,setLabel]=useState(edition.label);
  const [publisher,setPublisher]=useState(edition.publisher??'');
  const [identifiers,setIdentifiers]=useState<Identifier[]>(
    edition.identifiers.map(item=>({kind:item.kind,value:item.value})));
  const [contributors,setContributors]=useState<Contributor[]>(
    edition.contributors.map(item=>({
      authorId:item.authorId,role:item.role,sortOrder:String(item.sortOrder),
    })));
  const [busy,setBusy]=useState(false);
  const [stale,setStale]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const canChangeIdentifiers=edition.identifiers.length<=30;
  const canChangeContributors=edition.contributors.length<=50;
  const disabled=busy||stale||!online||edition.status!=='draft';

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(disabled)return;
    const next:Record<string,unknown>={expectedVersion:parentVersion};
    if(label.trim()!==edition.label)next.label=label;
    if((publisher.trim()||null)!==edition.publisher)next.publisher=publisher.trim()||null;
    const safeIdentifiers=identifiers.map(item=>({
      kind:item.kind,value:item.value.trim(),
    }));
    const safeContributors=contributors.map(item=>({
      authorId:item.authorId,role:item.role,sortOrder:parsedOrder(item.sortOrder),
    }));
    if(canChangeIdentifiers&&JSON.stringify(safeIdentifiers)!==
      JSON.stringify(edition.identifiers))next.identifiers=safeIdentifiers;
    if(canChangeContributors&&JSON.stringify(safeContributors)!==
      JSON.stringify(edition.contributors))next.contributors=safeContributors;
    if(Object.keys(next).length===1){setError(w.unchanged);return;}
    const parsed=adminCatalogEditionMetadataPatchSchema.safeParse(next);
    if(!parsed.success){setError(w.validation);return;}
    setBusy(true);setError('');setNotice('');
    try{
      const result=await patchAdminEdition(workId,edition.id,parsed.data);
      if(result.metadataVersion!==parentVersion+1){
        throw new CatalogClientError('unexpected');
      }
      setNotice(w.success);
      onReload();
    }catch(cause){
      setError(catalogErrorText(cause,language));
      if(cause instanceof CatalogClientError&&
        (cause.kind==='conflict'||cause.kind==='network')){
        setStale(true);setNotice(w.stale);
      }
    }finally{setBusy(false);}
  }
  return <section data-testid="admin-edition-editor"
    className="folio-catalog-card folio-catalog-edition-editor"
    aria-label={w.title}>
    <h3>{w.title}</h3>
    <p>{w.info}</p>
    <p>{w.status}: {edition.status} · {edition.language.toUpperCase()}</p>
    <p>{w.version}: <strong>{parentVersion}</strong></p>
    <form className="folio-catalog-fields" onSubmit={event=>{void submit(event);}}>
      <label htmlFor="folio-update-edition-label">{w.label}</label>
      <input id="folio-update-edition-label" required maxLength={400}
        value={label} disabled={disabled}
        onChange={event=>setLabel(event.target.value)}/>
      <label htmlFor="folio-update-edition-publisher">{w.publisher}</label>
      <input id="folio-update-edition-publisher" maxLength={240}
        value={publisher} disabled={disabled}
        onChange={event=>setPublisher(event.target.value)}/>
      <fieldset><legend>{w.identifier}</legend>
        {canChangeIdentifiers?<>
          {identifiers.map((item,index)=><div key={index}
            className="folio-catalog-relation">
            <select aria-label={w.kind+' '+(index+1)}
              value={item.kind} disabled={disabled}
              onChange={event=>setIdentifiers(list=>list.map((row,i)=>i===index?{
                ...row,kind:event.target.value as Identifier['kind']}:row))}>
              <option value="isbn-10">ISBN-10</option>
              <option value="isbn-13">ISBN-13</option>
              <option value="other">{w.identifier}</option>
            </select>
            <input aria-label={w.value+' '+(index+1)} maxLength={150} required
              value={item.value} disabled={disabled}
              onChange={event=>setIdentifiers(list=>list.map((row,i)=>i===index?{
                ...row,value:event.target.value}:row))}/>
            <button type="button" className="folio-catalog-secondary"
              aria-label={w.remove+' '+w.identifier+' '+(index+1)}
              disabled={disabled} onClick={()=>setIdentifiers(list=>list.filter((_,i)=>i!==index))}>
              {w.remove}</button>
          </div>)}
          <button type="button" className="folio-catalog-secondary"
            disabled={disabled||identifiers.length>=30}
            onClick={()=>setIdentifiers(list=>[...list,{kind:'isbn-13',value:''}])}>
            {w.addIdentifier}</button>
        </>:<p role="status">{w.limit}</p>}
      </fieldset>
      <fieldset><legend>{w.contributors}</legend>
        {canChangeContributors?<>
          {contributors.map((item,index)=><div key={index}
            className="folio-catalog-relation">
            <input aria-label={w.authorId+' '+(index+1)} required
              value={item.authorId} maxLength={36} disabled={disabled}
              onChange={event=>setContributors(list=>list.map((row,i)=>i===index?{
                ...row,authorId:event.target.value}:row))}/>
            <select aria-label={w.role+' '+(index+1)} value={item.role}
              disabled={disabled}
              onChange={event=>setContributors(list=>list.map((row,i)=>i===index?{
                ...row,role:event.target.value as Contributor['role']}:row))}>
              {(['author','translator','editor','illustrator'] as const).map(role=>
                <option key={role} value={role}>{role}</option>)}
            </select>
            <input aria-label={w.order+' '+(index+1)} required maxLength={5}
              inputMode="numeric" value={item.sortOrder} disabled={disabled}
              onChange={event=>setContributors(list=>list.map((row,i)=>i===index?{
                ...row,sortOrder:event.target.value}:row))}/>
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
        </>:<p role="status">{w.limit}</p>}
      </fieldset>
      <div className="folio-catalog-actions">
        <button type="submit" disabled={disabled}>{w.save}</button>
        <button type="button" className="folio-catalog-secondary"
          disabled={busy} onClick={onCancel}>{w.cancel}</button>
        {stale&&<button type="button" disabled={busy||!online}
          onClick={onReload}>{w.reload}</button>}
      </div>
    </form>
    {busy&&<p role="status">{w.busy}</p>}
    {notice&&<p role="status" className="folio-catalog-notice">{notice}</p>}
    {error&&<p role="alert" className="folio-catalog-alert">{error}</p>}
  </section>;
}
