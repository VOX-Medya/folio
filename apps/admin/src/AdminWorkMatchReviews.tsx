import {useEffect,useState} from 'react';
import type {FormEvent} from 'react';
import type {AdminWorkMatchPage} from '@folio/contracts';
import {adminWorkMatchProposeSchema,adminWorkMatchDecisionSchema} from '@folio/contracts';
import {
  CatalogClientError,catalogErrorText,listAdminWorkMatchReviews,
  proposeAdminWorkMatchReview,decideAdminWorkMatchReview,
} from './admin-catalog-client.js';

type Language='tr'|'en';
type Review=AdminWorkMatchPage['items'][number];
interface Props{workId:string;language:Language;online:boolean}
const copy={
  tr:{
    heading:'Eser kimliği incelemesi',notice:'Şüpheli iki taslak eserin bağımsız editör incelemesi. Karar eserleri birleştirmez, içe alımı veya yayını onaylamaz.',
    candidate:'Diğer kanonik eser UUID',create:'İnceleme kaydı aç',reload:'İncelemeleri sunucudan yenile',
    noReviews:'Bu eser için henüz inceleme kaydı yok.',loading:'Yetkili incelemeler yükleniyor…',
    saving:'İnceleme sunucuda kaydediliyor…',success:'Sunucu yanıtı doğrulandı; güncel kayıtlar yeniden okunuyor.',
    validation:'UUID, karar ve açıklama alanlarını kontrol edin. İstek gönderilmedi.',
    help:'Kararı yalnız teklifi açandan farklı, bu cihazda MFA doğrulamış bir katalog editörü verebilir.',
    evidence:'Kanıt',sameTitle:'Aynı özgün başlık',hash:'Aynı kaynak SHA-256',isbn:'Aynı kayıtlı ISBN (kimlik kanıtı değil)',manual:'Manuel karşılaştırma',
    version:'İnceleme sürümü',current:'Güncel kanıt',stale:'Kaynak metadata değişti. Yeniden inceleme kaydı açılmalı.',
    choose:'Kararı incele',decision:'İnceleme kararı',distinct:'Farklı eserler',deferred:'Daha fazla kanıt gerekli',
    rationale:'Gerekçeli editoryal açıklama (en az 24 karakter)',confirm:'Kararı açıkça kaydet',
    cancel:'Vazgeç',more:'Diğer kayıtlar',locked:'Çakışma veya belirsiz ağ yanıtı sonrası otomatik tekrar yok. Güncel kayıtları yükleyin.',
    pending:'Bekliyor',doneDistinct:'Farklı eser',doneDeferred:'Ertelendi',
  },
  en:{
    heading:'Work identity review',notice:'Independent editorial review of two potentially related draft works. A decision never merges works or approves imports, rights or publication.',
    candidate:'Other canonical work UUID',create:'Propose identity review',reload:'Reload reviews from server',
    noReviews:'No identity reviews exist for this work.',loading:'Loading authorized reviews…',
    saving:'Saving verified review on the server…',success:'Server response verified; reloading current records.',
    validation:'Check UUID, decision and rationale. Nothing was sent.',
    help:'Only a different MFA-verified catalog editor may decide a review they did not propose.',
    evidence:'Evidence',sameTitle:'Matching original title',hash:'Matching source SHA-256',isbn:'Matching stored ISBN (not proof of identity)',manual:'Manual comparison',
    version:'Review version',current:'Current evidence',stale:'Source metadata changed. The review must be proposed again.',
    choose:'Review decision',decision:'Editorial decision',distinct:'Distinct works',deferred:'More evidence required',
    rationale:'Editorial rationale (at least 24 characters)',confirm:'Explicitly record decision',
    cancel:'Cancel',more:'More records',locked:'No automatic retry after conflict or uncertain response. Reload current records.',
    pending:'Pending',doneDistinct:'Distinct',doneDeferred:'Deferred',
  },
} as const;

/** This panel only ever reads real authenticated work metadata. It is opened
 * deliberately from a verified DRAFT work detail, not a public catalog. */
export function AdminWorkMatchReviews({workId,language,online}:Props){
  const w=copy[language];
  const [items,setItems]=useState<Review[]>([]);
  const [cursor,setCursor]=useState<string|null>(null);
  const [state,setState]=useState<'loading'|'ready'|'error'>('loading');
  const [candidate,setCandidate]=useState('');
  const [selected,setSelected]=useState<Review|null>(null);
  const [decision,setDecision]=useState<'distinct'|'deferred'>('deferred');
  const [rationale,setRationale]=useState('');
  const [busy,setBusy]=useState(false);
  const [locked,setLocked]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');

  useEffect(()=>{
    let active=true;
    setState('loading');setItems([]);setCursor(null);setSelected(null);
    if(!online){setState('error');return ()=>{active=false;};}
    void listAdminWorkMatchReviews(workId).then(page=>{
      if(!active)return;
      setItems(page.items);setCursor(page.nextCursor);setState('ready');
    }).catch(cause=>{
      if(!active)return;
      setError(catalogErrorText(cause,language));setState('error');
    });
    return ()=>{active=false;};
  },[workId,online]);

  async function reload(){
    if(!online||busy)return;
    setState('loading');setError('');setMessage('');
    try{
      const page=await listAdminWorkMatchReviews(workId);
      setItems(page.items);setCursor(page.nextCursor);setState('ready');
      setSelected(null);setLocked(false);
    }catch(cause){setState('error');setError(catalogErrorText(cause,language));}
  }
  async function nextPage(){
    if(!online||busy||!cursor)return;
    setBusy(true);setError('');
    try{
      const page=await listAdminWorkMatchReviews(workId,cursor);
      setItems(old=>[...old,...page.items]);setCursor(page.nextCursor);
    }catch(cause){setError(catalogErrorText(cause,language));}
    finally{setBusy(false);}
  }
  function failure(cause:unknown){
    setError(catalogErrorText(cause,language));
    if(cause instanceof CatalogClientError&&
      (cause.kind==='conflict'||cause.kind==='network')){
      setLocked(true);setMessage(w.locked);
    }
  }
  async function propose(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!online||busy||locked)return;
    const parsed=adminWorkMatchProposeSchema.safeParse({candidateWorkId:candidate.trim()});
    if(!parsed.success||parsed.data.candidateWorkId===workId){
      setError(w.validation);return;
    }
    setError('');setMessage('');setBusy(true);
    try{
      const result=await proposeAdminWorkMatchReview(workId,parsed.data);
      if(!result.id||!['pending','distinct','deferred'].includes(result.status)){
        throw new CatalogClientError('unexpected');
      }
      const page=await listAdminWorkMatchReviews(workId);
      setItems(page.items);setCursor(page.nextCursor);setState('ready');
      setSelected(null);setCandidate('');setMessage(w.success);
    }catch(cause){failure(cause);}
    finally{setBusy(false);}
  }
  async function submitDecision(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!selected||!online||busy||locked)return;
    const input=adminWorkMatchDecisionSchema.safeParse({
      expectedVersion:selected.reviewVersion,decision,rationale,
    });
    if(!input.success){setError(w.validation);return;}
    setBusy(true);setError('');setMessage('');
    try{
      const result=await decideAdminWorkMatchReview(workId,selected.id,input.data);
      if(result.status!==decision||result.reviewVersion!==selected.reviewVersion+1||
        result.changed!==true){
        throw new CatalogClientError('unexpected');
      }
      const page=await listAdminWorkMatchReviews(workId);
      setItems(page.items);setCursor(page.nextCursor);setState('ready');
      setSelected(null);setRationale('');setMessage(w.success);
    }catch(cause){failure(cause);}
    finally{setBusy(false);}
  }
  const disabled=busy||!online||locked;
  const evidence=(value:Review['evidenceKind'])=>value==='shared_source_sha256'
    ?w.hash:value==='shared_isbn'?w.isbn:value==='same_title'?w.sameTitle:w.manual;
  const status=(value:Review['status'])=>value==='pending'
    ?w.pending:value==='distinct'?w.doneDistinct:w.doneDeferred;
  return <section className="folio-catalog-card folio-catalog-relations"
    aria-label={w.heading} data-testid="admin-work-match-reviews">
    <h3>{w.heading}</h3><p>{w.notice}</p><p>{w.help}</p>
    <form className="folio-catalog-fields" onSubmit={event=>{void propose(event);}}>
      <label htmlFor="folio-match-candidate">{w.candidate}</label>
      <input id="folio-match-candidate" required minLength={36} maxLength={36}
        disabled={disabled} autoComplete="off" value={candidate}
        onChange={event=>setCandidate(event.target.value)}/>
      <div className="folio-catalog-actions">
        <button type="submit" disabled={disabled}>{w.create}</button>
        <button type="button" className="folio-catalog-secondary" disabled={!online||busy}
          onClick={()=>{void reload();}}>{w.reload}</button>
      </div>
    </form>
    {state==='loading'&&<p role="status">{w.loading}</p>}
    {state==='ready'&&items.length===0&&<p role="status">{w.noReviews}</p>}
    {state==='ready'&&<ul>{items.map(row=><li key={row.id}>
      <p><strong>{row.peerTitle}</strong> · <code>{row.peerWorkId}</code></p>
      <p>{w.evidence}: {evidence(row.evidenceKind)} · {w.version}: {row.reviewVersion} · {status(row.status)}</p>
      {!row.snapshotCurrent&&<p role="status">{w.stale}</p>}
      {row.status==='pending'&&row.snapshotCurrent&&<button type="button"
        className="folio-catalog-secondary" disabled={disabled||!!selected}
        aria-label={w.choose+': '+row.peerTitle}
        onClick={()=>{setSelected(row);setDecision('deferred');setRationale('');
          setError('');setMessage('');}}>{w.choose}</button>}
    </li>)}</ul>}
    {cursor&&state==='ready'&&<button type="button" className="folio-catalog-secondary"
      disabled={!online||busy} onClick={()=>{void nextPage();}}>{w.more}</button>}
    {selected&&<form className="folio-catalog-fields"
      aria-label={w.confirm} onSubmit={event=>{void submitDecision(event);}}>
      <p>{selected.peerTitle} · {w.version}: {selected.reviewVersion}</p>
      <label htmlFor="folio-match-decision">{w.decision}</label>
      <select id="folio-match-decision" value={decision} disabled={disabled}
        onChange={event=>setDecision(event.target.value as typeof decision)}>
        <option value="deferred">{w.deferred}</option>
        <option value="distinct">{w.distinct}</option>
      </select>
      <label htmlFor="folio-match-rationale">{w.rationale}</label>
      <textarea id="folio-match-rationale" required minLength={24} maxLength={1200}
        value={rationale} disabled={disabled}
        onChange={event=>setRationale(event.target.value)}/>
      <div className="folio-catalog-actions">
        <button type="submit" disabled={disabled}>{w.confirm}</button>
        <button type="button" className="folio-catalog-secondary" disabled={busy}
          onClick={()=>{setSelected(null);setRationale('');setError('');}}>
          {w.cancel}</button>
      </div>
    </form>}
    {busy&&<p role="status">{w.saving}</p>}
    {message&&<p role="status" className="folio-catalog-notice">{message}</p>}
    {error&&<p role="alert" className="folio-catalog-alert">{error}</p>}
  </section>;
}
