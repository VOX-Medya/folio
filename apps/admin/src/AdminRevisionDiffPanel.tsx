import {useEffect,useRef,useState} from 'react';
import type {FormEvent} from 'react';
import {adminCatalogIdSchema} from '@folio/contracts';
import type {AdminCatalogRevisionDiff} from '@folio/contracts';
import {
  CatalogClientError,catalogErrorText,getAdminRevisionDiff,
} from './admin-catalog-client.js';

type Language='tr'|'en';
const counts=['added','removed','text_changed','metadata_changed','moved','unchanged'] as const;
const copy={
  tr:{
    title:'Revizyon farklarını incele',info:'Salt okunur SHA-256 ve semantik blok kimliği incelemesi. Kaynak metin, hak kanıtı ve özel dosya içeriği gösterilmez; bu işlem yayın onayı değildir.',
    entry:'Bu aşamada revizyon listesi yoktur. Yalnız önceden yetkili kaynaktan doğruladığınız iki revizyon UUID değerini girin.',
    from:'Önceki revizyon UUID',to:'Yeni revizyon UUID',
    compare:'Metadata farkını getir',next:'Sonraki blok sayfası',restart:'İlk sayfa',
    invalid:'Her iki revizyon için farklı ve geçerli UUID girin. İstek gönderilmedi.',
    loading:'Yetkili revizyon farkı yükleniyor…',
    empty:'Bu sayfada gösterilecek blok değişikliği yok.',
    chapter:'Değişen bölüm sayısı',block:'Blok UUID',
    before:'Önce',after:'Sonra',kind:'Değişiklik',position:'Bölüm / sıra',
    sha:'Metin SHA-256',flags:'Görünümler',none:'Yok',
    added:'Eklenen',removed:'Silinen',text_changed:'Metni değişen',
    metadata_changed:'Metadata değişen',moved:'Taşınan',unchanged:'Değişmeyen',
    page:'Bu sayfadaki değişen bloklar',privacy:'Yalnız metadata; özgün kitap metni alınmaz.',
  },
  en:{
    title:'Review revision differences',info:'Read-only SHA-256 and semantic block identity inspection. Source text, rights evidence and private file bodies are not displayed; this is not publication approval.',
    entry:'Revision listings are not available yet. Enter two revision UUIDs verified through an authorized source.',
    from:'Earlier revision UUID',to:'Later revision UUID',
    compare:'Load metadata differences',next:'Next block page',restart:'First page',
    invalid:'Enter two different, valid revision UUIDs. No request was sent.',
    loading:'Loading authorized revision differences…',
    empty:'No changed blocks on this page.',
    chapter:'Changed chapters',block:'Block UUID',
    before:'Before',after:'After',kind:'Change class',position:'Chapter / order',
    sha:'Text SHA-256',flags:'Modes',none:'None',
    added:'Added',removed:'Removed',text_changed:'Text changed',
    metadata_changed:'Metadata changed',moved:'Moved',unchanged:'Unchanged',
    page:'Changed blocks on this page',privacy:'Metadata only; no original book text is retrieved.',
  },
} as const;

type Position=NonNullable<AdminCatalogRevisionDiff['items'][number]['before']>;
function PositionInfo({value,language}:{value:Position|null;language:Language}){
  const w=copy[language];
  if(!value)return <span>{w.none}</span>;
  const modes=[
    ...(value.includeNormal?['normal']:[]),
    ...(value.includeRsvp?['RSVP']:[]),
    ...(value.includeAudio?['audio']:[]),
  ];
  return <div className="folio-revision-position">
    <span>{w.position}: <code>{value.chapterId}</code> / {value.ordinal}</span>
    <span>{value.kind} · {w.flags}: {modes.join(', ')||w.none}</span>
    <span>{w.sha}: <code>{value.textSha256}</code></span>
  </div>;
}

/** Only explicitly selected canonical revision UUIDs are sent over the
 * existing MFA+RBAC verified HTTPS GET. No body, cached token or approval. */
export function AdminRevisionDiffPanel({
  workId,editionId,language,online,
}:{
  workId:string;editionId:string;language:Language;online:boolean;
}){
  const w=copy[language];
  const [fromId,setFromId]=useState('');
  const [toId,setToId]=useState('');
  const [result,setResult]=useState<AdminCatalogRevisionDiff|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const seq=useRef(0),abort=useRef<AbortController|null>(null);

  useEffect(()=>()=>{seq.current++;abort.current?.abort();},[]);
  useEffect(()=>{
    if(!online){
      seq.current++;abort.current?.abort();
      setBusy(false);setResult(null);
    }
  },[online]);
  function reset(){
    seq.current++;abort.current?.abort();
    setResult(null);setBusy(false);setError('');
  }
  async function load(cursor?:string){
    if(!online||busy)return;
    const from=adminCatalogIdSchema.safeParse(fromId.trim());
    const to=adminCatalogIdSchema.safeParse(toId.trim());
    if(!from.success||!to.success||from.data===to.data){
      setError(w.invalid);return;
    }
    const ticket=++seq.current;
    abort.current?.abort();
    const controller=new AbortController();
    abort.current=controller;
    setBusy(true);setError('');
    try{
      const page=await getAdminRevisionDiff(
        workId,editionId,from.data,to.data,cursor,controller.signal,
      );
      if(ticket!==seq.current)return;
      if(page.editionId!==editionId||page.fromRevisionId!==from.data||
        page.toRevisionId!==to.data||
        (cursor!==undefined&&result!==null&&
          JSON.stringify(page.summary)!==JSON.stringify(result.summary))){
        throw new CatalogClientError('unexpected');
      }
      // Display ONE bounded server page at a time, not an unbounded local cache.
      setResult(page);
    }catch(cause){
      if(ticket!==seq.current)return;
      // A newly denied MFA/RBAC check invalidates previously visible metadata.
      setResult(null);
      setError(catalogErrorText(cause,language));
    }finally{
      if(ticket===seq.current)setBusy(false);
    }
  }
  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();void load();
  }
  return <section className="folio-catalog-card folio-revision-diff"
    data-testid="admin-revision-diff" aria-label={w.title}>
    <h3>{w.title}</h3>
    <p>{w.info}</p>
    <p>{w.entry}</p>
    <form className="folio-catalog-fields" onSubmit={submit}>
      <label htmlFor={'folio-revision-from-'+editionId}>{w.from}</label>
      <input id={'folio-revision-from-'+editionId} type="text"
        autoComplete="off" spellCheck={false} maxLength={36} required
        value={fromId} disabled={busy||!online}
        onChange={event=>{reset();setFromId(event.target.value);}}/>
      <label htmlFor={'folio-revision-to-'+editionId}>{w.to}</label>
      <input id={'folio-revision-to-'+editionId} type="text"
        autoComplete="off" spellCheck={false} maxLength={36} required
        value={toId} disabled={busy||!online}
        onChange={event=>{reset();setToId(event.target.value);}}/>
      <div className="folio-catalog-actions">
        <button type="submit" disabled={busy||!online}>{w.compare}</button>
      </div>
    </form>
    {busy&&<p role="status">{w.loading}</p>}
    {error&&<p className="folio-catalog-alert" role="alert">{error}</p>}
    {result&&<>
      <p role="status">{w.privacy}</p>
      <dl className="folio-revision-counts">
        {counts.map(kind=><div key={kind}>
          <dt>{w[kind]}</dt><dd>{result.summary[kind]}</dd>
        </div>)}
        <div><dt>{w.chapter}</dt><dd>{result.chapterChanges.length}</dd></div>
      </dl>
      <h4>{w.page}: {result.items.length}</h4>
      {result.items.length===0&&<p role="status">{w.empty}</p>}
      <ul className="folio-revision-items">
        {result.items.map(item=><li key={item.blockId}>
          <strong>{w.block}: <code>{item.blockId}</code></strong>
          <p>{w.kind}: {w[item.kind]}</p>
          <div className="folio-revision-sides">
            <div><h5>{w.before}</h5><PositionInfo value={item.before} language={language}/></div>
            <div><h5>{w.after}</h5><PositionInfo value={item.after} language={language}/></div>
          </div>
        </li>)}
      </ul>
      <div className="folio-catalog-actions">
        {result.nextCursor&&<button type="button" disabled={busy||!online}
          onClick={()=>{void load(result.nextCursor??undefined);}}>{w.next}</button>}
        {result.nextCursor===null&&result.items.length>0&&<span>{w.privacy}</span>}
        <button type="button" className="folio-catalog-secondary"
          disabled={busy||!online} onClick={()=>{void load();}}>{w.restart}</button>
      </div>
    </>}
  </section>;
}
