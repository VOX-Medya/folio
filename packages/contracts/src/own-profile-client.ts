import {
  ownProfileSchema,ownProfileUpdateSchema,ownDeletionRequestSchema,ownDeletionResultSchema,
} from './index.js';
import type {OwnProfile} from './index.js';
import {fetchWebSessionCsrf,WebSessionHttpError} from './web-session-client.js';
type Options={fetcher?:typeof fetch;signal?:AbortSignal};
function origin(raw:string):string{
  if(typeof window==='undefined'||typeof document==='undefined')throw Error('Browser HTTPS required');
  let url:URL;
  try{url=new URL(raw);}catch{throw Error('Configured HTTPS origin required');}
  if(url.protocol!=='https:'||url.origin!==raw||url.pathname!=='/'||url.search||url.hash||
    url.username||url.password||window.location.origin!==url.origin){
    throw Error('Same-origin HTTPS private profile required');
  }
  return url.origin;
}
async function payload<T>(response:Response,schema:{parse:(raw:unknown)=>T}):Promise<T>{
  if(!response.ok)throw new WebSessionHttpError(response.status,'PRIVATE_PROFILE_DENIED',null);
  if(response.status!==200)throw new WebSessionHttpError(response.status,'INVALID_PROFILE_RESPONSE',null);
  let value:unknown;
  try{value=await response.json();}catch{throw new WebSessionHttpError(200,'INVALID_PROFILE_RESPONSE',null);}
  try{return schema.parse(value);}
  catch{throw new WebSessionHttpError(200,'INVALID_PROFILE_RESPONSE',null);}
}
function init(method:'GET'|'PATCH'|'POST',signal?:AbortSignal,csrf?:string,body?:string):RequestInit{
  return {method,mode:'same-origin',credentials:'same-origin',cache:'no-store',
    redirect:'error',referrerPolicy:'no-referrer',
    headers:{accept:'application/json',...(csrf?{'x-folio-csrf':csrf}:{}),
      ...(body?{'content-type':'application/json'}:{})},
    ...(body?{body}:{}),...(signal?{signal}:{}),
  };
}
/** No account ID, email or token is ever accepted from browser inputs. */
export async function fetchOwnWebProfile(base:string,options?:Options):Promise<OwnProfile>{
  const url=origin(base);
  const response=await (options?.fetcher??fetch)(url+'/v1/me/profile',init('GET',options?.signal));
  return payload(response,ownProfileSchema);
}
export async function updateOwnWebProfile(base:string,raw:unknown,options?:Options):Promise<OwnProfile>{
  const url=origin(base),input=ownProfileUpdateSchema.parse(raw);
  const csrf=await fetchWebSessionCsrf({baseUrl:url,
    ...(options?.fetcher?{fetcher:options.fetcher}:{}),
    ...(options?.signal?{signal:options.signal}:{}),
  });
  const response=await (options?.fetcher??fetch)(url+'/v1/me/profile',
    init('PATCH',options?.signal,csrf,JSON.stringify(input)));
  return payload(response,ownProfileSchema);
}
export async function requestOwnWebDeletion(base:string,raw:unknown,options?:Options){
  const url=origin(base),input=ownDeletionRequestSchema.parse(raw);
  const csrf=await fetchWebSessionCsrf({baseUrl:url,
    ...(options?.fetcher?{fetcher:options.fetcher}:{}),
    ...(options?.signal?{signal:options.signal}:{}),
  });
  const response=await (options?.fetcher??fetch)(url+'/v1/me/profile/deletion-request',
    init('POST',options?.signal,csrf,JSON.stringify(input)));
  return payload(response,ownDeletionResultSchema);
}
