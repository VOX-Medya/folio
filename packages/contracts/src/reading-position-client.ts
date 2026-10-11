import {readingPositionInputSchema,readingPositionResponseSchema} from './index.js';
import type {ReadingPositionResponse} from './index.js';
import {fetchWebSessionCsrf,WebSessionHttpError} from './web-session-client.js';

type Options={fetcher?:typeof fetch;signal?:AbortSignal};
function trustedOrigin(value:string):string{
  let url:URL;
  try{url=new URL(value);}catch{throw Error('Reader requires configured HTTPS origin');}
  if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||
     url.username||url.password||url.origin!==value||
     (typeof window!=='undefined'&&window.location.origin!==value)){
    throw Error('Reader requires same-origin HTTPS');
  }
  return url.origin;
}
async function verifiedJson(response:Response):Promise<ReadingPositionResponse>{
  if(!response.ok)throw new WebSessionHttpError(response.status,'REQUEST_DENIED',null);
  let json:unknown;
  try{json=await response.json();}
  catch{throw new WebSessionHttpError(200,'INVALID_RESPONSE',null);}
  const parsed=readingPositionResponseSchema.safeParse(json);
  if(!parsed.success)throw new WebSessionHttpError(200,'INVALID_RESPONSE',null);
  return parsed.data;
}
async function bootstrap(base:string,options?:Options){
  return fetchWebSessionCsrf({baseUrl:base,
    ...(options?.fetcher?{fetcher:options.fetcher}:{}),
    ...(options?.signal?{signal:options.signal}:{})});
}
/** Current HTTPS verified cookie owns the reader position. Never accepts userId. */
export async function fetchOwnReadingPosition(baseUrl:string,rawRevisionId:unknown,
  options?:Options):Promise<ReadingPositionResponse>{
  const base=trustedOrigin(baseUrl);
  const id=readingPositionResponseSchema.shape.position.unwrap().shape.revisionId
    .parse(rawRevisionId);
  await bootstrap(base,options);
  const reply=await (options?.fetcher??fetch)(
    base+'/v1/me/reading-position/'+encodeURIComponent(id),{
      method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',
      redirect:'error',referrerPolicy:'no-referrer',headers:{accept:'application/json'},
      ...(options?.signal?{signal:options.signal}:{}),
    });
  return verifiedJson(reply);
}
/** CAS on expectedVersion: simultaneous/stale device writes report HTTP 409. */
export async function saveOwnReadingPosition(baseUrl:string,rawRevisionId:unknown,
  rawInput:unknown,options?:Options):Promise<ReadingPositionResponse>{
  const base=trustedOrigin(baseUrl);
  const id=readingPositionResponseSchema.shape.position.unwrap().shape.revisionId
    .parse(rawRevisionId);
  const body=readingPositionInputSchema.parse(rawInput);
  const csrf=await bootstrap(base,options);
  const reply=await (options?.fetcher??fetch)(
    base+'/v1/me/reading-position/'+encodeURIComponent(id),{
      method:'PUT',credentials:'same-origin',mode:'same-origin',cache:'no-store',
      redirect:'error',referrerPolicy:'no-referrer',
      headers:{accept:'application/json','content-type':'application/json','x-folio-csrf':csrf},
      body:JSON.stringify(body),...(options?.signal?{signal:options.signal}:{}),
    });
  return verifiedJson(reply);
}
