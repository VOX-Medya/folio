import {useEffect,useState} from 'react';
import type {FormEvent} from 'react';
import type {AdminImportCandidatePage} from '@folio/contracts';
import {
  adminImportCandidateProposeSchema,adminWorkMatchDecisionSchema,
} from '@folio/contracts';
import {
  CatalogClientError,catalogErrorText,listAdminImportCandidateReviews,
  proposeAdminImportCandidateReview,decideAdminImportCandidateReview,
} from './admin-catalog-client.js';

type Language='tr'|'en';
type Review=AdminImportCandidatePage['items'][number];
const copy={
  tr:{
    heading:'Paket eser çakışması incelemeleri',
    notice:'Bunlar bir Folio paketinden kopyalanan, henüz doğrulanmamış metadata iddialarıdır. Bu ekran paket doğrulaması, kanonik eser birleştirme, hak onayı veya içe alma izni vermez.',
    packageId:'Paket UUID',checksum:'Manifest SHA-256',incomingId:'Gelen eser UUID',
    title:'Gelen eser özgün başlığı',language:'Gelen dil',source:'Kaynak SHA-256 (isteğe bağlı iddia)',
    propose:'İncelemeyi aç',reload:'Güncel incelemeleri yükle',
    loading:'Güvenli inceleme listesi yükleniyor…',empty:'Henüz gelen eser incelemesi yok.',
    unverified:'Paket dosyası ve SHA kanıtı doğrulanmadı. İçe alma hâlâ engelli.',
    statusPending:'Bekliyor',statusDistinct:'Farklı eser iddiası',statusDeferred:'Ertelendi',
    evidenceTitle:'Başlık eşleşmesi iddiası',evidenceHash:'Kaynak SHA eşleşmesi iddiası',
    review:'Kararı incele',version:'İnceleme sürümü',
    stale:'Kanonik eser metadata sürümü değişti; yeni teklif gerekir.',
    verdict:'Editoryal karar',distinct:'Ayrı eser olarak not et',deferred:'Kanıt bekle',
    rationale:'Bağımsız editör gerekçesi (en az 24 karakter)',confirm:'Kararı açıkça kaydet',
    cancel:'İptal',more:'Diğer incelemeler',saving:'Sunucu kararı doğruluyor…',
    saved:'Sunucu yanıtı doğrulandı; kayıt yeniden okundu.',
    invalid:'Paket kimliğini, SHA değerlerini ve açıklamayı kontrol edin.',
    locked:'Çakışma veya belirsiz ağ yanıtı sonrası otomatik tekrar yok. Güncel listeyi yükleyin.',
  },
  en:{
    heading:'Incoming package identity reviews',
    notice:'These are UNVERIFIED metadata claims copied from a Folio package. This panel cannot verify packages, merge canonical works, grant rights or permit imports.',
    packageId:'Package UUID',checksum:'Manifest SHA-256',incomingId:'Incoming work UUID',
    title:'Incoming original work title',language:'Incoming language',source:'Claimed source SHA-256 (optional)',
    propose:'Propose review',reload:'Reload current reviews',
    loading:'Loading authorized review list…',empty:'No incoming identity reviews yet.',
    unverified:'Package bytes and hash evidence are unverified. Import remains blocked.',
    statusPending:'Pending',statusDistinct:'Claim marked distinct',statusDeferred:'Deferred',
    evidenceTitle:'Claimed title match',evidenceHash:'Claimed source SHA match',
    review:'Review decision',version:'Review version',
    stale:'Canonical work metadata has changed; a new proposal is required.',
    verdict:'Editorial judgment',distinct:'Mark as distinct',deferred:'Need more evidence',
    rationale:'Independent reviewer rationale (minimum 24 characters)',confirm:'Explicitly record decision',
    cancel:'Cancel',more:'More reviews',saving:'Verifying server response…',
    saved:'Server response verified; review reloaded.',
    invalid:'Check package UUID, SHA values and rationale.',
    locked:'No blind retry after version conflict or uncertain network response. Reload current list.',
  },
} as const;
interface Props{candidateWorkId:string;online:boolean;language:Language}
/** Private admin metadata only, never a web package-upload or staging API. */
export function AdminImportCandidateReviews({candidateWorkId,online,language}:Props){
  const w=copy[language];
  const [rows,setRows]=useState<Review[]>([]);
  const [cursor,setCursor]=useState<string|null>(null);
  const [state,setState]=useState<'loading'|'ready'|'error'>('loading');
  const [packageId,setPackageId]=useState('');
  const [checksum,setChecksum]=useState('');
  const [incomingId,setIncomingId]=useState('');
  const [title,setTitle]=useState('');
  const [incomingLanguage,setIncomingLanguage]=useState<'tr'|'en'>('tr');
  const [sourceSha,setSourceSha]=useState('');
  const [selected,setSelected]=useState<Review|null>(null);
  const [decision,setDecision]=useState<'distinct'|'deferred'>('deferred');
  const [rationale,setRationale]=useState('');
  const [busy,setBusy]=useState(false);
  const [locked,setLocked]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');

  useEffect(()=>{
    let active=true;
    setState('loading');setRows([]);setCursor(null);setSelected(null);
    if(!online){setState('error');return ()=>{active=false;};}
    void listAdminImportCandidateReviews(candidateWorkId).then(page=>{
      if(!active)return;
      setRows(page.items);setCursor(page.nextCursor);setState('ready');
    }).catch(cause=>{
      if(!active)return;
      setError(catalogErrorText(cause,language));setState('error');
    });
    return ()=>{active=false;};
  },[candidateWorkId,online]);

  async function reload(){
    if(!online||busy)return;
    setState('loading');setError('');setMessage('');
    try{
      const page=await listAdminImportCandidateReviews(candidateWorkId);
      setRows(page.items);setCursor(page.nextCursor);setState('ready');
      setSelected(null);setLocked(false);
    }catch(cause){setState('error');setError(catalogErrorText(cause,language));}
  }
  async function more(){
    if(!online||busy||!cursor)return;
    setBusy(true);setError('');
    try{
      const page=await listAdminImportCandidateReviews(candidateWorkId,cursor);
      setRows(old=>[...old,...page.items]);setCursor(page.nextCursor);
    }catch(cause){setError(catalogErrorText(cause,language));}
    finally{setBusy(false);}
  }
  function failed(cause:unknown){
    setError(catalogErrorText(cause,language));
    if(cause instanceof CatalogClientError&&
      (cause.kind==='conflict'||cause.kind==='network')){
      setLocked(true);setMessage(w.locked);
    }
  }
  async function propose(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!online||busy||locked)return;
    const raw={
      packageId:packageId.trim(),manifestChecksum:checksum.trim(),
      incomingWorkId:incomingId.trim(),incomingTitle:title.trim(),
      incomingLanguage,
      ...(sourceSha.trim()?{sourceSha256:sourceSha.trim()}:{}),
    };
    const parsed=adminImportCandidateProposeSchema.safeParse(raw);
    if(!parsed.success||parsed.data.incomingWorkId===candidateWorkId){
      setError(w.invalid);return;
    }
    setBusy(true);setError('');setMessage('');
    try{
      const result=await proposeAdminImportCandidateReview(candidateWorkId,parsed.data);
      if(result.provenanceVerified!==false){
        throw new CatalogClientError('unexpected');
      }
      const page=await listAdminImportCandidateReviews(candidateWorkId);
      setRows(page.items);setCursor(page.nextCursor);setState('ready');
      setSelected(null);setMessage(w.saved);
    }catch(cause){failed(cause);}
    finally{setBusy(false);}
  }
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!selected||!online||busy||locked)return;
    const parsed=adminWorkMatchDecisionSchema.safeParse({
      expectedVersion:selected.reviewVersion,decision,rationale,
    });
    if(!parsed.success){setError(w.invalid);return;}
    setBusy(true);setError('');setMessage('');
    try{
      const result=await decideAdminImportCandidateReview(
        candidateWorkId,selected.id,parsed.data);
      if(result.status!==decision||result.reviewVersion!==selected.reviewVersion+1||
        !result.changed||result.provenanceVerified!==false){
        throw new CatalogClientError('unexpected');
      }
      const page=await listAdminImportCandidateReviews(candidateWorkId);
      setRows(page.items);setCursor(page.nextCursor);setState('ready');
      setSelected(null);setRationale('');setMessage(w.saved);
    }catch(cause){failed(cause);}
    finally{setBusy(false);}
  }
  const disabled=!online||busy||locked;
  const status=(s:Review['status'])=>s==='pending'?w.statusPending:
    s==='distinct'?w.statusDistinct:w.statusDeferred;
  return <section className="folio-catalog-card folio-catalog-relations"
    data-testid="admin-import-candidate-reviews" aria-label={w.heading}>
    <h3>{w.heading}</h3><p>{w.notice}</p><p>{w.unverified}</p>
    <form className="folio-catalog-fields" onSubmit={e=>{void propose(e);}}>
      <label htmlFor="folio-import-review-package">{w.packageId}</label>
      <input id="folio-import-review-package" required autoComplete="off"
        minLength={36} maxLength={36} disabled={disabled}
        value={packageId} onChange={e=>setPackageId(e.target.value)}/>
      <label htmlFor="folio-import-review-checksum">{w.checksum}</label>
      <input id="folio-import-review-checksum" required autoComplete="off"
        minLength={64} maxLength={64} disabled={disabled}
        value={checksum} onChange={e=>setChecksum(e.target.value)}/>
      <label htmlFor="folio-import-review-work">{w.incomingId}</label>
      <input id="folio-import-review-work" required autoComplete="off"
        minLength={36} maxLength={36} disabled={disabled}
        value={incomingId} onChange={e=>setIncomingId(e.target.value)}/>
      <label htmlFor="folio-import-review-title">{w.title}</label>
      <input id="folio-import-review-title" required autoComplete="off"
        minLength={1} maxLength={600} disabled={disabled}
        value={title} onChange={e=>setTitle(e.target.value)}/>
      <label htmlFor="folio-import-review-lang">{w.language}</label>
      <select id="folio-import-review-lang" disabled={disabled}
        value={incomingLanguage}
        onChange={e=>setIncomingLanguage(e.target.value as 'tr'|'en')}>
        <option value="tr">TR</option><option value="en">EN</option>
      </select>
      <label htmlFor="folio-import-review-source">{w.source}</label>
      <input id="folio-import-review-source" autoComplete="off"
        maxLength={64} disabled={disabled} value={sourceSha}
        onChange={e=>setSourceSha(e.target.value)}/>
      <div className="folio-catalog-actions">
        <button type="submit" disabled={disabled}>{w.propose}</button>
        <button type="button" className="folio-catalog-secondary"
          disabled={!online||busy} onClick={()=>{void reload();}}>{w.reload}</button>
      </div>
    </form>
    {state==='loading'&&<p role="status">{w.loading}</p>}
    {state==='ready'&&rows.length===0&&<p role="status">{w.empty}</p>}
    {state==='ready'&&<ul>{rows.map(row=><li key={row.id}>
      <p><strong>{row.incomingTitle}</strong> ({row.incomingLanguage.toUpperCase()})</p>
      <p><code>{row.incomingWorkId}</code> · {w.packageId}: <code>{row.packageId}</code></p>
      <p>{status(row.status)} · {w.version}: {row.reviewVersion} ·
        {row.evidenceKind==='claimed_source_sha256'?w.evidenceHash:w.evidenceTitle}</p>
      {!row.snapshotCurrent&&<p role="status">{w.stale}</p>}
      {row.status==='pending'&&row.snapshotCurrent&&
        <button type="button" className="folio-catalog-secondary"
          aria-label={w.review+': '+row.incomingTitle}
          disabled={disabled||!!selected} onClick={()=>{
            setSelected(row);setRationale('');setDecision('deferred');setError('');setMessage('');
          }}>{w.review}</button>}
    </li>)}</ul>}
    {state==='ready'&&cursor&&
      <button type="button" className="folio-catalog-secondary"
        disabled={!online||busy} onClick={()=>{void more();}}>{w.more}</button>}
    {selected&&<form className="folio-catalog-fields" aria-label={w.confirm}
      onSubmit={e=>{void submit(e);}}>
      <p>{selected.incomingTitle} · {w.version}: {selected.reviewVersion}</p>
      <label htmlFor="folio-import-review-decision">{w.verdict}</label>
      <select id="folio-import-review-decision" disabled={disabled} value={decision}
        onChange={e=>setDecision(e.target.value as typeof decision)}>
        <option value="deferred">{w.deferred}</option><option value="distinct">{w.distinct}</option>
      </select>
      <label htmlFor="folio-import-review-rationale">{w.rationale}</label>
      <textarea id="folio-import-review-rationale" disabled={disabled} required
        minLength={24} maxLength={1200}
        value={rationale} onChange={e=>setRationale(e.target.value)}/>
      <div className="folio-catalog-actions">
        <button type="submit" disabled={disabled}>{w.confirm}</button>
        <button type="button" className="folio-catalog-secondary" disabled={busy}
          onClick={()=>{setSelected(null);setRationale('');setError('');}}>{w.cancel}</button>
      </div>
    </form>}
    {busy&&<p role="status">{w.saving}</p>}
    {message&&<p role="status">{message}</p>}
    {error&&<p role="alert" className="folio-catalog-alert">{error}</p>}
  </section>;
}
