import {readingPositionResponseSchema,readingPositionUpdateSchema} from './index.js';
import type {ReadingPositionResponse} from './index.js';
import {fetchWebSessionCsrf,WebSessionHttpError} from './web-session-client.js';

type Options={fetcher?:typeof fetch;signal?:AbortSignal};
function secureOrigin(raw:string):string{
  if(typeof window==='undefined'||typeof document==='undefined')throw Error('Browser HTTPS required');
  let url:URL;
  try{url=new URL(raw);}catch{throw Error('Configured HTTPS progress origin required');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||
    url.search||url.hash||url.origin!==raw||window.location.origin!==url.origin){
    throw Error('Same-origin HTTPS progress required');
  }
  return url.origin;
}
function revision(raw:unknown):string{
  return readingPositionResponseSchema.shape.progress.unwrap().shape.revisionId.parse(raw);
}
async function parse(response:Response):Promise<ReadingPositionResponse>{
  if(!response.ok)throw new WebSessionHttpError(response.status,'READING_PROGRESS_DENIED',null);
  if(response.status!==200)throw new WebSessionHttpError(response.status,'INVALID_PROGRESS_RESPONSE',null);
  let raw:unknown;
  try{raw=await response.json();}catch{throw new WebSessionHttpError(200,'INVALID_PROGRESS_RESPONSE',null);}
  const parsed=readingPositionResponseSchema.safeParse(raw);
  if(!parsed.success)throw new WebSessionHttpError(200,'INVALID_PROGRESS_RESPONSE',null);
  return parsed.data;
}
/** Exact-origin HttpOnly web cookie is the ONLY browser identity. */
export async function fetchOwnWebReadingPosition(
  base:string,rawRevision:unknown,options?:Options,
):Promise<ReadingPositionResponse>{
  const origin=secureOrigin(base),id=revision(rawRevision);
  const response=await (options?.fetcher??fetch)(origin+'/v1/me/progress/'+encodeURIComponent(id),{
    method:'GET',credentials:'same-origin',mode:'same-origin',redirect:'error',
    cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json'},
    ...(options?.signal?{signal:options.signal}:{}),
  });
  return parse(response);
}
export async function saveOwnWebReadingPosition(
  base:string,rawRevision:unknown,rawUpdate:unknown,options?:Options,
):Promise<ReadingPositionResponse>{
  const origin=secureOrigin(base),id=revision(rawRevision);
  const body=readingPositionUpdateSchema.parse(rawUpdate);
  const csrf=await fetchWebSessionCsrf({baseUrl:origin,
    ...(options?.fetcher?{fetcher:options.fetcher}:{}),
    ...(options?.signal?{signal:options.signal}:{}),
  });
  const response=await (options?.fetcher??fetch)(origin+'/v1/me/progress/'+encodeURIComponent(id),{
    method:'PUT',credentials:'same-origin',mode:'same-origin',redirect:'error',
    cache:'no-store',referrerPolicy:'no-referrer',
    headers:{accept:'application/json','content-type':'application/json','x-folio-csrf':csrf},
    body:JSON.stringify(body),...(options?.signal?{signal:options.signal}:{}),
  });
  return parse(response);
}
