import {
  adminCatalogAuthorCreatedSchema,adminCatalogAuthorDetailSchema,
  adminCatalogAuthorPageSchema,adminCatalogIdSchema,
  adminCatalogSearchQuerySchema,adminCatalogWorkCreatedSchema,
  adminCatalogWorkDetailSchema,adminCatalogWorkPageSchema,
  authorCreateSchema,workCreateSchema,
  canonicalAuthorMetadataPatchSchema,canonicalWorkMetadataPatchSchema,
  canonicalAuthorMetadataUpdatedSchema,canonicalWorkMetadataUpdatedSchema,
  adminCatalogEditionAppendSchema,adminCatalogEditionAppendedSchema,
  adminCatalogTitleAppendSchema,adminCatalogTitleAppendedSchema,
  adminCatalogWorkAuthorAppendSchema,adminCatalogWorkAuthorAppendedSchema,
  adminCatalogEditionMetadataPatchSchema,adminCatalogEditionMetadataUpdatedSchema,
  adminCatalogRelationRemoveSchema,
  adminCatalogRevisionDiffQuerySchema,adminCatalogRevisionDiffSchema,
  adminCatalogRevisionListQuerySchema,adminCatalogRevisionListSchema,
  adminCatalogRightsLedgerQuerySchema,adminCatalogRightsLedgerSchema,
} from '@folio/contracts';
import type {
  AdminCatalogAuthorDetail,AdminCatalogAuthorPage,
  AdminCatalogWorkDetail,AdminCatalogWorkPage,
  AuthorCreate,WorkCreate,CanonicalAuthorMetadataPatch,
  CanonicalWorkMetadataPatch,AdminCatalogEditionAppend,
  AdminCatalogTitleAppend,AdminCatalogWorkAuthorAppend,
  AdminCatalogEditionMetadataPatch,AdminCatalogRevisionDiff,
  AdminCatalogRevisionList,AdminCatalogRightsLedger,
} from '@folio/contracts';
import {AdminMfaClientError,bootstrapAdminWebCsrf} from './admin-mfa-client.js';

/** The admin browser NEVER sees bearer/session values; the server owns the
 * Secure HttpOnly SameSite=Strict cookie, current MFA proof and RBAC roles.
 * No origin, actor, publication state, TOTP or permission is a client input. */
export type CatalogClientErrorKind=
  'secure-https'|'offline'|'unauthorized'|'forbidden'|'disabled'|'not-found'|
  'conflict'|'invalid'|'unavailable'|'network'|'unexpected';
export class CatalogClientError extends Error {
  constructor(readonly kind:CatalogClientErrorKind){
    super(kind);
    this.name='CatalogClientError';
  }
}
type CatalogCollection='authors'|'works';
type CatalogVerb='GET'|'POST'|'PATCH'|'DELETE';

export function requireSecureCatalogBrowser():void{
  if(typeof window==='undefined'||window.location.protocol!=='https:'){
    throw new CatalogClientError('secure-https');
  }
  if(typeof navigator!=='undefined'&&navigator.onLine===false){
    throw new CatalogClientError('offline');
  }
}
export function catalogErrorText(error:unknown,language:'tr'|'en'):string{
  const kind=error instanceof CatalogClientError?error.kind:'unexpected';
  const labels={
    tr:{
      'secure-https':'Katalog yalnız doğrulanmış HTTPS ortamında kullanılabilir.',
      offline:'Çevrimdışısın. Katalog değişiklikleri kuyruğa alınmaz.',
      unauthorized:'Oturum doğrulanamadı. Ayarlar bölümünden giriş yap.',
      forbidden:'Yönetici rolü ve bu cihazda geçerli MFA doğrulaması gerekli.',
      disabled:'Katalog sunucu yapılandırmasında kapalı.',
      'not-found':'Kayıt bulunamadı veya kaldırıldı.',
      conflict:'Başka bir yönetici kaydı değiştirdi. Yeni sürümü yükleyip tekrar incele.',
      invalid:'Girilen katalog alanları veya ilişki geçersiz.',
      unavailable:'Katalog hizmeti şu anda kullanılamıyor.',
      network:'Ağ isteği tamamlanamadı. Kaydetme tekrar gönderilmedi.',
      unexpected:'Katalog yanıtı beklenen sözleşmeye uymuyor.',
    },
    en:{
      'secure-https':'The catalog requires a verified HTTPS connection.',
      offline:'Offline. Catalog edits are never queued.',
      unauthorized:'Session not verified. Sign in under Settings.',
      forbidden:'Administrator role and current-device MFA verification required.',
      disabled:'Catalog operations are disabled on this server.',
      'not-found':'Record is missing or has been removed.',
      conflict:'Another editor changed this record. Reload and review the new revision.',
      invalid:'Invalid catalog field or relationship.',
      unavailable:'The catalog service is unavailable.',
      network:'Network request failed. The write was not resent.',
      unexpected:'Catalog response does not match the expected contract.',
    },
  } as const;
  return labels[language][kind];
}
function checkedId(value:string):string{
  const parsed=adminCatalogIdSchema.safeParse(value);
  if(!parsed.success)throw new CatalogClientError('invalid');
  return parsed.data;
}
function csrfFailure(cause:unknown):CatalogClientError{
  if(cause instanceof CatalogClientError)return cause;
  if(cause instanceof AdminMfaClientError){
    const kind=cause.kind;
    if(kind==='secure-https'||kind==='unauthorized'||kind==='forbidden'||
      kind==='disabled'||kind==='unavailable'||kind==='invalid'||kind==='network'){
      return new CatalogClientError(kind);
    }
  }
  return new CatalogClientError('unexpected');
}

async function request(
  path:string,method:CatalogVerb,expected:200|201,
  body?:unknown,signal?:AbortSignal,
):Promise<unknown>{
  requireSecureCatalogBrowser();
  // Paths originate from a static collection union, checked UUID and URLSearchParams.
  if(!/^\/v1\/admin\/catalog\/(?:authors|works)(?:[/?]|$)/.test(path)||
    path.includes('//')||path.includes('#')){
    throw new CatalogClientError('invalid');
  }
  const headers:Record<string,string>={Accept:'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET'){
    let token:string;
    try{token=await bootstrapAdminWebCsrf();}
    catch(cause){throw csrfFailure(cause);}
    // The HMAC CSRF header is ephemeral; never put it in storage, query or logs.
    headers['x-folio-csrf']=token;
  }
  let response:Response;
  try{
    response=await fetch(path,{
      method,
      mode:'same-origin',credentials:'same-origin',redirect:'error',
      cache:'no-store',referrerPolicy:'no-referrer',
      headers,
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      ...(signal===undefined?{}:{signal}),
    });
  }catch{
    throw new CatalogClientError('network');
  }
  if(response.status!==expected){
    const codes:Record<number,CatalogClientErrorKind>={
      400:'invalid',401:'unauthorized',403:'forbidden',
      409:'conflict',429:'unavailable',503:'unavailable',
    };
    const kind=response.status===404
      ?(path.includes('/authors/')||path.includes('/works/')?'not-found':'disabled')
      :(codes[response.status]??'unexpected');
    throw new CatalogClientError(kind);
  }
  if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json'){
    throw new CatalogClientError('unexpected');
  }
  try{return await response.json() as unknown;}
  catch{throw new CatalogClientError('unexpected');}
}
function parse<T>(data:unknown,validator:(data:unknown)=>T):T{
  try{return validator(data);}
  catch{throw new CatalogClientError('unexpected');}
}
function searchPath(kind:CatalogCollection,q:string,cursor?:string){
  const query=adminCatalogSearchQuerySchema.safeParse({
    q,limit:20,...(cursor===undefined?{}:{cursor}),
  });
  if(!query.success)throw new CatalogClientError('invalid');
  const params=new URLSearchParams({q:query.data.q,limit:String(query.data.limit)});
  if(query.data.cursor)params.set('cursor',query.data.cursor);
  return '/v1/admin/catalog/'+kind+'?'+params.toString();
}
export async function searchAdminAuthors(
  query:string,cursor?:string,signal?:AbortSignal,
):Promise<AdminCatalogAuthorPage>{
  const data=await request(searchPath('authors',query,cursor),'GET',200,undefined,signal);
  return parse(data,raw=>adminCatalogAuthorPageSchema.parse(raw));
}
export async function searchAdminWorks(
  query:string,cursor?:string,signal?:AbortSignal,
):Promise<AdminCatalogWorkPage>{
  const data=await request(searchPath('works',query,cursor),'GET',200,undefined,signal);
  return parse(data,raw=>adminCatalogWorkPageSchema.parse(raw));
}
export async function getAdminAuthor(id:string,signal?:AbortSignal):Promise<AdminCatalogAuthorDetail>{
  const data=await request('/v1/admin/catalog/authors/'+checkedId(id),'GET',200,undefined,signal);
  return parse(data,raw=>adminCatalogAuthorDetailSchema.parse(raw));
}
export async function getAdminWork(id:string,signal?:AbortSignal):Promise<AdminCatalogWorkDetail>{
  const data=await request('/v1/admin/catalog/works/'+checkedId(id),'GET',200,undefined,signal);
  return parse(data,raw=>adminCatalogWorkDetailSchema.parse(raw));
}
export async function createAdminAuthor(input:AuthorCreate){
  const valid=authorCreateSchema.safeParse(input);
  if(!valid.success)throw new CatalogClientError('invalid');
  const raw=await request('/v1/admin/catalog/authors','POST',201,valid.data);
  return parse(raw,data=>adminCatalogAuthorCreatedSchema.parse(data));
}
export async function createAdminWork(input:WorkCreate){
  const valid=workCreateSchema.safeParse(input);
  if(!valid.success)throw new CatalogClientError('invalid');
  const raw=await request('/v1/admin/catalog/works','POST',201,valid.data);
  return parse(raw,data=>adminCatalogWorkCreatedSchema.parse(data));
}
export async function patchAdminAuthor(id:string,input:CanonicalAuthorMetadataPatch){
  const valid=canonicalAuthorMetadataPatchSchema.safeParse(input);
  if(!valid.success)throw new CatalogClientError('invalid');
  const raw=await request('/v1/admin/catalog/authors/'+checkedId(id),'PATCH',200,valid.data);
  return parse(raw,data=>canonicalAuthorMetadataUpdatedSchema.parse(data));
}
export async function patchAdminWork(id:string,input:CanonicalWorkMetadataPatch){
  const valid=canonicalWorkMetadataPatchSchema.safeParse(input);
  if(!valid.success)throw new CatalogClientError('invalid');
  const raw=await request('/v1/admin/catalog/works/'+checkedId(id),'PATCH',200,valid.data);
  return parse(raw,data=>canonicalWorkMetadataUpdatedSchema.parse(data));
}

/** These strictly metadata-only commands never upload EPUB/PDF, alter rights
 * or publish content. Every POST requires a fresh exact-origin Web CSRF. */
export async function appendAdminWorkEdition(id:string,input:AdminCatalogEditionAppend){
  const parsed=adminCatalogEditionAppendSchema.safeParse(input);
  if(!parsed.success)throw new CatalogClientError('invalid');
  const raw=await request('/v1/admin/catalog/works/'+checkedId(id)+'/editions',
    'POST',201,parsed.data);
  return parse(raw,value=>adminCatalogEditionAppendedSchema.parse(value));
}
export async function appendAdminWorkTitle(id:string,input:AdminCatalogTitleAppend){
  const parsed=adminCatalogTitleAppendSchema.safeParse(input);
  if(!parsed.success)throw new CatalogClientError('invalid');
  const raw=await request('/v1/admin/catalog/works/'+checkedId(id)+'/titles',
    'POST',201,parsed.data);
  return parse(raw,value=>adminCatalogTitleAppendedSchema.parse(value));
}
export async function appendAdminWorkAuthor(id:string,input:AdminCatalogWorkAuthorAppend){
  const parsed=adminCatalogWorkAuthorAppendSchema.safeParse(input);
  if(!parsed.success)throw new CatalogClientError('invalid');
  const raw=await request('/v1/admin/catalog/works/'+checkedId(id)+'/authors',
    'POST',201,parsed.data);
  return parse(raw,value=>adminCatalogWorkAuthorAppendedSchema.parse(value));
}

/** Deleting an optional relation is a guarded, versioned edit, never a
 * canonical author/text deletion. Unknown/stale responses never auto-retry. */
export async function removeAdminWorkTitle(
  workId:string,titleId:string,input:{expectedVersion:number},
){
  const parsed=adminCatalogRelationRemoveSchema.safeParse(input);
  if(!parsed.success)throw new CatalogClientError('invalid');
  const raw=await request(
    '/v1/admin/catalog/works/'+checkedId(workId)+'/titles/'+checkedId(titleId),
    'DELETE',200,parsed.data,
  );
  return parse(raw,value=>adminCatalogTitleAppendedSchema.parse(value));
}
export async function removeAdminWorkAuthor(
  workId:string,authorId:string,input:{expectedVersion:number},
){
  const parsed=adminCatalogRelationRemoveSchema.safeParse(input);
  if(!parsed.success)throw new CatalogClientError('invalid');
  const raw=await request(
    '/v1/admin/catalog/works/'+checkedId(workId)+'/authors/'+checkedId(authorId),
    'DELETE',200,parsed.data,
  );
  return parse(raw,value=>adminCatalogWorkAuthorAppendedSchema.parse(value));
}

/** Only versioned bibliographic metadata of a DRAFT edition is editable.
 * No client can supply publish/rights/language/source revisions. */
export async function patchAdminEdition(
  workId:string,editionId:string,input:AdminCatalogEditionMetadataPatch,
){
  const parsed=adminCatalogEditionMetadataPatchSchema.safeParse(input);
  if(!parsed.success)throw new CatalogClientError('invalid');
  const raw=await request(
    '/v1/admin/catalog/works/'+checkedId(workId)+'/editions/'+checkedId(editionId),
    'PATCH',200,parsed.data,
  );
  return parse(raw,value=>adminCatalogEditionMetadataUpdatedSchema.parse(value));
}

/** Read-only, bounded, server-authorized comparison. This does not query
 * revision contents or create a publication/rights approval. The caller
 * supplies only validated UUIDs and a server-issued pagination cursor. */
export async function getAdminRevisionDiff(
  workId:string,editionId:string,fromRevisionId:string,toRevisionId:string,
  cursor?:string,signal?:AbortSignal,
):Promise<AdminCatalogRevisionDiff>{
  const parsed=adminCatalogRevisionDiffQuerySchema.safeParse({
    fromRevisionId,limit:50,...(cursor===undefined?{}:{cursor}),
  });
  if(!parsed.success)throw new CatalogClientError('invalid');
  // All IDs are checked BEFORE the HTTPS request, including the target revision.
  const work=checkedId(workId),edition=checkedId(editionId),to=checkedId(toRevisionId);
  if(parsed.data.fromRevisionId===to)throw new CatalogClientError('invalid');
  const query=new URLSearchParams({
    fromRevisionId:parsed.data.fromRevisionId,limit:String(parsed.data.limit),
  });
  if(parsed.data.cursor)query.set('cursor',parsed.data.cursor);
  const raw=await request(
    '/v1/admin/catalog/works/'+work+'/editions/'+edition+
      '/revisions/'+to+'/diff?'+query.toString(),
    'GET',200,undefined,signal,
  );
  const result=parse(raw,data=>adminCatalogRevisionDiffSchema.parse(data));
  if(result.editionId!==edition||result.fromRevisionId!==parsed.data.fromRevisionId||
    result.toRevisionId!==to){
    throw new CatalogClientError('unexpected');
  }
  return result;
}

/** No publication, source body or account fields. GET-only immutable revision
 * identity selector using the same safe cookie transport as the diff endpoint. */
export async function getAdminRevisionList(
  workId:string,editionId:string,cursor?:string,signal?:AbortSignal,
):Promise<AdminCatalogRevisionList>{
  const parsed=adminCatalogRevisionListQuerySchema.safeParse({
    limit:20,...(cursor===undefined?{}:{cursor}),
  });
  if(!parsed.success)throw new CatalogClientError('invalid');
  const work=checkedId(workId),edition=checkedId(editionId);
  const query=new URLSearchParams({limit:String(parsed.data.limit)});
  if(parsed.data.cursor)query.set('cursor',parsed.data.cursor);
  const raw=await request(
    '/v1/admin/catalog/works/'+work+'/editions/'+edition+
      '/revisions?'+query.toString(),
    'GET',200,undefined,signal,
  );
  const result=parse(raw,value=>adminCatalogRevisionListSchema.parse(value));
  if(result.editionId!==edition)throw new CatalogClientError('unexpected');
  return result;
}

/** Current HTTPS session + current-device MFA and persisted rights:read
 * are enforced at the server. Claims here NEVER imply permission to publish.
 * No document bodies, reviewer IDs, bearer, raw evidence or asset keys. */
export async function getAdminRightsLedger(
  workId:string,cursor?:string,signal?:AbortSignal,
):Promise<AdminCatalogRightsLedger>{
  const parsed=adminCatalogRightsLedgerQuerySchema.safeParse({
    limit:20,...(cursor===undefined?{}:{cursor}),
  });
  if(!parsed.success)throw new CatalogClientError('invalid');
  const work=checkedId(workId);
  const query=new URLSearchParams({limit:String(parsed.data.limit)});
  if(parsed.data.cursor)query.set('cursor',parsed.data.cursor);
  const raw=await request(
    '/v1/admin/catalog/works/'+work+'/rights?'+query.toString(),
    'GET',200,undefined,signal,
  );
  const result=parse(raw,value=>adminCatalogRightsLedgerSchema.parse(value));
  if(result.workId!==work)throw new CatalogClientError('unexpected');
  return result;
}
