import {
  publishedCatalogSearchPageSchema,publishedCatalogSearchQuerySchema,
  shelfListSchema,shelfUpdateSchema,publishedCatalogItemSchema,
} from './index.js';
import type {PublishedCatalogSearchPage,ShelfList} from './index.js';
import {fetchWebSessionCsrf,WebSessionHttpError} from './web-session-client.js';

interface PublicOptions{signal?:AbortSignal;fetcher?:typeof fetch;}
function origin(value:string):string{
  let url:URL;
  try{url=new URL(value);}catch{throw new Error('Configured HTTPS origin required');}
  if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||
    url.search||url.hash||url.origin!==value||
    (typeof window!=='undefined'&&window.location.origin!==value)){
    throw new Error('Same-origin HTTPS required');
  }
  return url.origin;
}
const init=(method:'GET'|'PUT'|'DELETE',credentials:'omit'|'same-origin',
  signal?:AbortSignal,csrf?:string,body?:string):RequestInit=>({
    method,mode:'same-origin',credentials,cache:'no-store',redirect:'error',
    referrerPolicy:'no-referrer',headers:{
      accept:'application/json',
      ...(csrf?{'x-folio-csrf':csrf}:{}),
      ...(body?{'content-type':'application/json'}:{}),
    },...(body?{body}:{}),...(signal?{signal}:{}),
  });
async function parse(response:Response,schema:{safeParse:(raw:unknown)=>{success:boolean;data?:unknown}}){
  if(!response.ok)throw new WebSessionHttpError(response.status,'REQUEST_DENIED',null);
  let raw:unknown;
  try{raw=await response.json();}catch{throw new WebSessionHttpError(200,'INVALID_RESPONSE',null);}
  const value=schema.safeParse(raw);
  if(!value.success)throw new WebSessionHttpError(200,'INVALID_RESPONSE',null);
  return value.data;
}

/** Public published books/authors only; no user/people search is available. */
export async function searchPublicCatalog(
  baseUrl:string,rawQuery:unknown,options?:PublicOptions,
):Promise<PublishedCatalogSearchPage>{
  const base=origin(baseUrl);
  const query=publishedCatalogSearchQuerySchema.parse(rawQuery);
  const params=new URLSearchParams({q:query.q,limit:String(query.limit)});
  const response=await (options?.fetcher??fetch)(
    base+'/v1/catalog/search?'+params.toString(),init('GET','omit',options?.signal));
  return (await parse(response,publishedCatalogSearchPageSchema)) as PublishedCatalogSearchPage;
}

/** Browser uses server-verified HttpOnly cookie only. Native bearer is #30. */
export async function fetchOwnWebShelf(baseUrl:string,options?:PublicOptions):Promise<ShelfList>{
  const base=origin(baseUrl);
  await fetchWebSessionCsrf({baseUrl:base,fetcher:options?.fetcher,signal:options?.signal});
  const response=await (options?.fetcher??fetch)(
    base+'/v1/me/shelf',init('GET','same-origin',options?.signal));
  return (await parse(response,shelfListSchema)) as ShelfList;
}

export async function saveOwnWebShelf(baseUrl:string,rawWorkId:unknown,rawStatus:unknown,options?:PublicOptions){
  const base=origin(baseUrl);
  const workId=publishedCatalogItemSchema.shape.id.parse(rawWorkId);
  const body=shelfUpdateSchema.parse(rawStatus);
  const csrf=await fetchWebSessionCsrf({baseUrl:base,fetcher:options?.fetcher,signal:options?.signal});
  const response=await (options?.fetcher??fetch)(
    base+'/v1/me/shelf/'+encodeURIComponent(workId),
    init('PUT','same-origin',options?.signal,csrf,JSON.stringify(body)));
  return (await parse(response,{
    safeParse:(raw:unknown)=>{
      const good=!!raw&&typeof raw==='object'&&!Array.isArray(raw)&&
        Object.keys(raw).length===1&&(raw as {saved?:unknown}).saved===true;
      return {success:good,data:raw};
    },
  })) as {saved:true};
}

export async function removeOwnWebShelf(baseUrl:string,rawWorkId:unknown,options?:PublicOptions){
  const base=origin(baseUrl);
  const workId=publishedCatalogItemSchema.shape.id.parse(rawWorkId);
  const csrf=await fetchWebSessionCsrf({baseUrl:base,fetcher:options?.fetcher,signal:options?.signal});
  const response=await (options?.fetcher??fetch)(
    base+'/v1/me/shelf/'+encodeURIComponent(workId),
    init('DELETE','same-origin',options?.signal,csrf));
  if(!response.ok)throw new WebSessionHttpError(response.status,'REQUEST_DENIED',null);
  if(response.status!==204)throw new WebSessionHttpError(response.status,'INVALID_RESPONSE',null);
}
