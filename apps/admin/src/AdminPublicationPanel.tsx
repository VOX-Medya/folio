import {useEffect,useRef,useState} from 'react';
import {adminPublicationCommandSchema} from '@folio/contracts';
import type {AdminCatalogRevisionList} from '@folio/contracts';
import {catalogErrorText,changeAdminPublication,getAdminRevisionList} from './admin-catalog-client.js';

type Language='tr'|'en';
type Edition={id:string;label:string;status:string};
const copy={
  tr:{
    title:'Yayın incelemesi',info:'Kaynak doğrulaması, güncel üç kapsamlı telif izni ve yetkili MFA yoksa yayın engellenir. Hak onayı bu formdan verilmez.',
    edition:'Baskı',revision:'Metin revizyonu',list:'Revizyonları getir',next:'Sonraki revizyonlar',
    choose:'Revizyon seçin',territory:'Ülke (ISO 2 harf)',reason:'Yayın işlemi gerekçesi',
    publish:'İncele ve yayımla',withdraw:'Yayını geri çek',busy:'Sunucu denetimi sürüyor…',
    invalid:'Baskı, revizyon, ülke veya gerekçeyi kontrol edin (en az 8 karakter).',
    empty:'Bu baskıda revizyon yok.',selectEdition:'Önce bir baskı seçin.',
    published:'Yayın başarıyla kaydedildi.',withdrawn:'Yayın geri çekildi.',
    unavailable:'Yayıma uygun taslak veya mevcut yayın bulunamadı.',
  },
  en:{
    title:'Publication review',info:'No publication without verified source bytes, current rights at all three scopes and administrator MFA. This form does not approve rights.',
    edition:'Edition',revision:'Text revision',list:'Load revisions',next:'Next revisions',
    choose:'Choose a revision',territory:'Territory (2-letter ISO)',reason:'Editorial rationale',
    publish:'Review and publish',withdraw:'Withdraw publication',busy:'Checking on server…',
    invalid:'Check edition, revision, territory and rationale (at least 8 characters).',
    empty:'This edition has no revisions.',selectEdition:'Select an edition first.',
    published:'Publication saved.',withdrawn:'Publication withdrawn.',
    unavailable:'No eligible draft or existing publication.',
  },
} as const;

/** The browser never decides rights. Every action is a single CSRF-protected
 * HTTPS request, and no file path, session token or rights evidence is stored. */
export function AdminPublicationPanel({
  workId,workStatus,editions,language,online,onReload,
}:{
  workId:string;workStatus:string;editions:Edition[];
  language:Language;online:boolean;onReload:()=>void;
}){
  const w=copy[language];
  const [editionId,setEditionId]=useState(editions[0]?.id??'');
  const [page,setPage]=useState<AdminCatalogRevisionList|null>(null);
  const [revisionId,setRevisionId]=useState('');
  const [territory,setTerritory]=useState('TR');
  const [reason,setReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const current=useRef(0);
  useEffect(()=>()=>{current.current++;},[]);
  useEffect(()=>{
    setPage(null);setRevisionId('');setMessage('');setError('');
  },[editionId]);
  useEffect(()=>{
    if(!online){current.current++;setPage(null);setRevisionId('');setError('');}
  },[online]);
  async function load(cursor?:string){
    if(busy||!online||!editionId)return;
    const ticket=++current.current;
    setBusy(true);setError('');setMessage('');
    try{
      const next=await getAdminRevisionList(workId,editionId,cursor);
      if(ticket!==current.current)return;
      setPage(next);
      setRevisionId(next.items.find(item=>
        item.status==='draft'||item.status==='published')?.id??'');
    }catch(cause){
      if(ticket!==current.current)return;
      setPage(null);setRevisionId('');
      setError(catalogErrorText(cause,language));
    }finally{
      if(ticket===current.current)setBusy(false);
    }
  }
  async function change(action:'publish'|'withdraw'){
    if(busy||!online||!editionId||!revisionId)return;
    const command=adminPublicationCommandSchema.safeParse({action,territory,reason});
    if(!command.success){setError(w.invalid);return;}
    const ticket=++current.current;
    setBusy(true);setError('');setMessage('');
    try{
      const result=await changeAdminPublication(workId,editionId,revisionId,command.data);
      if(ticket!==current.current)return;
      setMessage(result.status==='published'?w.published:w.withdrawn);
      onReload();
    }catch(cause){
      if(ticket!==current.current)return;
      setError(catalogErrorText(cause,language));
    }finally{
      if(ticket===current.current)setBusy(false);
    }
  }
  const eligible=workStatus==='draft'||workStatus==='published';
  return <section className="folio-catalog-card" data-testid="admin-publication"
    aria-label={w.title}>
    <h3>{w.title}</h3>
    <p>{w.info}</p>
    {!eligible&&<p role="status">{w.unavailable}</p>}
    {eligible&&<>
      <label>{w.edition}
        <select value={editionId} disabled={!online||busy}
          onChange={e=>setEditionId(e.target.value)}>
          {editions.map(ed=><option key={ed.id} value={ed.id}>
            {ed.label} ({ed.status})
          </option>)}
        </select>
      </label>
      <div className="folio-catalog-actions">
        <button type="button" disabled={!online||busy||!editionId}
          onClick={()=>{void load();}}>{w.list}</button>
        {page?.nextCursor&&<button type="button" disabled={!online||busy}
          onClick={()=>{void load(page.nextCursor??undefined);}}>{w.next}</button>}
      </div>
      {page&&page.items.length===0&&<p role="status">{w.empty}</p>}
      <label>{w.revision}
        <select value={revisionId} disabled={!online||busy||!page}
          onChange={e=>setRevisionId(e.target.value)}>
          <option value="">{w.choose}</option>
          {page?.items.map(rev=><option key={rev.id} value={rev.id}>
            {rev.id} ({rev.status})
          </option>)}
        </select>
      </label>
      <label>{w.territory}
        <input value={territory} maxLength={2} disabled={!online||busy}
          onChange={e=>setTerritory(e.target.value.toUpperCase())}/>
      </label>
      <label>{w.reason}
        <textarea value={reason} maxLength={500} rows={2}
          disabled={!online||busy} onChange={e=>setReason(e.target.value)}/>
      </label>
      <div className="folio-catalog-actions">
        {workStatus==='draft'&&<button type="button"
          disabled={!online||busy||!revisionId||reason.trim().length<8}
          onClick={()=>{void change('publish');}}>{w.publish}</button>}
        {workStatus==='published'&&<button type="button"
          disabled={!online||busy||!revisionId||reason.trim().length<8}
          onClick={()=>{void change('withdraw');}}>{w.withdraw}</button>}
      </div>
    </>}
    {busy&&<p role="status">{w.busy}</p>}
    {message&&<p role="status">{message}</p>}
    {error&&<p role="alert" className="folio-catalog-alert">{error}</p>}
  </section>;
}
