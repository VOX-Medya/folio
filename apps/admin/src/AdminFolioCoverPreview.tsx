import type {AdminCatalogWorkDetail} from '@folio/contracts';
import {renderFolioCoverSvg} from '@folio/ui-tokens';
import type {FolioCoverTheme} from '@folio/ui-tokens';

type Language='tr'|'en';
const copy={
  tr:{
    heading:'Folio kapak önizlemesi',
    help:'Yalnız MFA ile doğrulanmış kanonik eser başlığı ve yazarları. Orijinal yayınevi kapağı, özel kaynak metin veya telif onayı gösterilmez.',
    unavailable:'Kanonik metadata bu şablonun güvenli sınırlarına uymuyor. Kapak oluşturulmadı.',
    original:'Özgün eser · salt okunur',
  },
  en:{
    heading:'Folio cover preview',
    help:'Only the canonical title and author names returned after MFA verification. No original publisher art, private text or rights approval.',
    unavailable:'Canonical metadata exceeds this template’s safe bounds. No cover was generated.',
    original:'Original work · read-only',
  },
} as const;

/** Private-by-context preview. Parent renders this ONLY after a fresh,
 * authenticated, direct HTTPS canonical-work detail request. Never infer
 * publication/territory rights from its presence; no side effects or fetch. */
export function AdminFolioCoverPreview({
  detail,language,theme,
}:{
  detail:AdminCatalogWorkDetail;
  language:Language;
  theme:FolioCoverTheme;
}){
  const w=copy[language];
  const authors=[...detail.authors].sort((a,b)=>
    a.sortOrder-b.sortOrder||a.id.localeCompare(b.id)).map(row=>row.name);
  let svg:string|null=null;
  try{
    // There is no verified canonical genre metadata yet; do NOT invent one.
    svg=renderFolioCoverSvg({
      workId:detail.work.id,language:detail.work.originalLanguage,
      title:detail.work.originalTitle,authors,genre:'',
      templateVersion:'paperbound-v1',theme,
    });
  }catch{
    // No fallback with fake authors, generated source content or publisher art.
  }
  const alt=detail.work.originalTitle+' — '+authors.join(', ');
  return <section className="folio-cover-preview" data-testid="admin-folio-cover-preview"
    aria-label={w.heading}>
    <h4>{w.heading}</h4>
    <p>{w.help}</p>
    {svg
      ?<figure>
        <img src={'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}
          width="320" height="480" alt={alt} loading="lazy"
          decoding="async" referrerPolicy="no-referrer"/>
        <figcaption>{w.original}</figcaption>
      </figure>
      :<p role="status">{w.unavailable}</p>}
  </section>;
}
