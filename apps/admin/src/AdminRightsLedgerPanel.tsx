import {useEffect,useRef,useState} from 'react';
import type {AdminCatalogRightsLedger} from '@folio/contracts';
import {
  catalogErrorText,getAdminRightsLedger,
} from './admin-catalog-client.js';

type Language='tr'|'en';
type Item=AdminCatalogRightsLedger['items'][number];
const copy={
  tr:{
    title:'Telif ve ülke izin iddiaları',
    intro:'Yalnız rights:read + güncel cihaz MFA yetkisiyle görülebilen salt okunur metadata. Bu kayıtlar, tek başına eserin yayımlanabileceği veya indirilebileceği anlamına gelmez. Kanıt metni, inceleyen kişi ve dosya yolu bu ekranda yoktur.',
    fetch:'Hak kayıtlarını getir',next:'Sonraki kayıtlar',refresh:'İlk sayfaya dön',
    loading:'Yetkili telif metadata kayıtları yükleniyor…',
    empty:'Bu eser için hak kaydı yok. Tüm dağıtım eylemleri kapalı kalır.',
    id:'Hak kaydı UUID',scope:'Kapsam',work:'Eser',edition:'Baskı',revision:'Revizyon',
    state:'İnceleme durumu',countries:'İddia edilen ülkeler',
    expiry:'Bitiş tarihi',permanent:'Bitiş tarihi belirtilmedi',
    claimed:'Talep edilen eylemler',yes:'Evet',no:'Hayır',
    display:'Gösterim',translation:'Çeviri',audio:'Ses',sharing:'Paylaşım',
    pending:'Beklemede',approved:'Onaylandı',rejected:'Reddedildi',withdrawn:'Geri çekildi',
    notARelease:'Onaylı tek bir kayıt bile ülke/baskı/revizyon zinciri ve dosya doğrulaması olmadan yayımlama izni değildir.',
  },
  en:{
    title:'Rights and territory claims',
    intro:'Read-only claim metadata restricted to rights:read plus current-device MFA. These rows do not authorize publication or downloads by themselves. No evidence body, reviewer identity or file path is exposed.',
    fetch:'Load rights records',next:'Next records',refresh:'Back to first page',
    loading:'Loading authorized rights claim metadata…',
    empty:'No rights records for this work. Distribution remains denied.',
    id:'Rights record UUID',scope:'Scope',work:'Work',edition:'Edition',revision:'Revision',
    state:'Review status',countries:'Claimed territories',
    expiry:'Expiry date',permanent:'No expiry specified',
    claimed:'Claimed actions',yes:'Yes',no:'No',
    display:'Display',translation:'Translation',audio:'Audio',sharing:'Sharing',
    pending:'Pending',approved:'Approved',rejected:'Rejected',withdrawn:'Withdrawn',
    notARelease:'Even one approved record never bypasses country, edition, revision or verified asset publication gates.',
  },
} as const;

function Scope({value,language}:{value:Item;language:Language}){
  const w=copy[language];
  if(value.revisionId){
    return <span>{w.revision}: <code>{value.revisionId}</code>
      <span> ({w.edition}: <code>{value.editionId}</code>)</span></span>;
  }
  if(value.editionId)return <span>{w.edition}: <code>{value.editionId}</code></span>;
  return <span>{w.work}</span>;
}

/** No edit/review/publish side effects. All rows come from the server's
 * rights:read MFA-enforced scope and contain no evidence or user secrets. */
export function AdminRightsLedgerPanel({
  workId,language,online,
}:{workId:string;language:Language;online:boolean}){
  const w=copy[language];
  const [page,setPage]=useState<AdminCatalogRightsLedger|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const sequence=useRef(0),pending=useRef<AbortController|null>(null);

  useEffect(()=>()=>{sequence.current++;pending.current?.abort();},[]);
  useEffect(()=>{
    if(!online){
      sequence.current++;pending.current?.abort();
      setLoading(false);setPage(null);setError('');
    }
  },[online]);
  async function load(cursor?:string){
    if(!online||loading)return;
    const ticket=++sequence.current;
    pending.current?.abort();
    const controller=new AbortController();
    pending.current=controller;
    setLoading(true);setError('');
    try{
      const received=await getAdminRightsLedger(workId,cursor,controller.signal);
      if(ticket!==sequence.current)return;
      setPage(received);
    }catch(cause){
      if(ticket!==sequence.current)return;
      // A revoked role/session MUST evict previously visible rights claims.
      setPage(null);
      setError(catalogErrorText(cause,language));
    }finally{
      if(ticket===sequence.current)setLoading(false);
    }
  }
  return <section className="folio-catalog-card folio-rights-ledger"
    data-testid="admin-rights-ledger" aria-label={w.title}>
    <h3>{w.title}</h3>
    <p>{w.intro}</p>
    <div className="folio-catalog-actions">
      <button type="button" disabled={loading||!online}
        onClick={()=>{void load();}}>{w.fetch}</button>
    </div>
    {loading&&<p role="status">{w.loading}</p>}
    {error&&<p className="folio-catalog-alert" role="alert">{error}</p>}
    {page&&<>
      <p role="status">{w.notARelease}</p>
      {page.items.length===0&&<p role="status">{w.empty}</p>}
      <ul className="folio-rights-rows">
        {page.items.map(record=><li key={record.id}>
          <h4>{w.id}: <code>{record.id}</code></h4>
          <dl>
            <div><dt>{w.scope}</dt><dd><Scope value={record} language={language}/></dd></div>
            <div><dt>{w.state}</dt><dd>{w[record.reviewStatus]}</dd></div>
            <div><dt>{w.countries}</dt><dd>{record.territories.join(', ')||'—'}</dd></div>
            <div><dt>{w.expiry}</dt><dd>{record.expiresAt??w.permanent}</dd></div>
          </dl>
          <p>{w.claimed}:</p>
          <ul className="folio-rights-claims">
            {(['display','translation','audio','sharing'] as const).map(key=>
              <li key={key}>{w[key]}: {record.claims[key]?w.yes:w.no}</li>)}
          </ul>
        </li>)}
      </ul>
      <div className="folio-catalog-actions">
        {page.nextCursor&&<button type="button" disabled={loading||!online}
          onClick={()=>{void load(page.nextCursor??undefined);}}>{w.next}</button>}
        <button type="button" className="folio-catalog-secondary"
          disabled={loading||!online} onClick={()=>{void load();}}>{w.refresh}</button>
      </div>
    </>}
  </section>;
}
