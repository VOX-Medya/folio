import {webLoginRequestSchema} from './index.js';
import {readFolioError} from './verified-request.js';

/**
 * Browser-only, direct HTTPS, SAME-ORIGIN cookie transport.
 * Never read, mirror, save or send the HttpOnly bearer in JS.
 * Native must use a separate platform-backed secure credential store.
 */
export interface WebSessionClientRequest {
  baseUrl:string;
  fetcher?:typeof fetch;
  signal?:AbortSignal;
}

export class WebSessionHttpError extends Error {
  constructor(
    readonly status:number,readonly code:string,readonly requestId:string|null,
  ){
    super('Web session request failed: '+code);
    this.name='WebSessionHttpError';
  }
}

function browserApiOrigin(baseUrl:string):string {
  if(typeof window==='undefined'||typeof document==='undefined'){
    throw new Error('A verified browser HTTPS context is required');
  }
  let url:URL;
  try{url=new URL(baseUrl);}
  catch{throw new Error('A verified same-origin HTTPS API is required');}
  if(url.protocol!=='https:'||url.username||url.password||
     url.pathname!=='/'||url.search||url.hash||
     url.origin!==baseUrl||window.location.origin!==url.origin){
    throw new Error('A verified same-origin HTTPS API is required');
  }
  return url.origin;
}
function requestInit(
  options:WebSessionClientRequest,method:'GET'|'POST',
  extra?:{body?:string;csrf?:string},
):RequestInit{
  return {
    method,
    mode:'same-origin',
    credentials:'same-origin',
    cache:'no-store',
    redirect:'error',
    referrerPolicy:'no-referrer',
    headers:{
      accept:'application/json',
      ...(extra?.body!==undefined?{'content-type':'application/json'}:{}),
      ...(extra?.csrf!==undefined?{'x-folio-csrf':extra.csrf}:{}),
    },
    ...(extra?.body!==undefined?{body:extra.body}:{}),
    ...(options.signal?{signal:options.signal}:{}),
  };
}
async function fail(response:Response):Promise<never>{
  const {code,requestId}=await readFolioError(response);
  throw new WebSessionHttpError(response.status,code,requestId);
}
function expectNoContent(response:Response):void {
  if(response.status!==204){
    throw new WebSessionHttpError(response.status,'UNEXPECTED_HTTP_RESPONSE',null);
  }
}

/**
 * POST only credentials. The server must set a __Host- HttpOnly cookie.
 * A 204 means accepted; no bearer/password may be returned in JSON.
 */
export async function loginWebSession(
  options:WebSessionClientRequest,rawCredentials:unknown,
):Promise<void>{
  const origin=browserApiOrigin(options.baseUrl);
  const data=webLoginRequestSchema.parse(rawCredentials);
  const response=await (options.fetcher??fetch)(
    origin+'/v1/auth/web/login',
    requestInit(options,'POST',{body:JSON.stringify(data)}),
  );
  if(!response.ok)return fail(response);
  expectNoContent(response);
}

/**
 * Bootstrap short-lived session-bound CSRF proof from the secure cookie only.
 * Returned value is ephemeral, never stored or written to URL/log.
 */
export async function fetchWebSessionCsrf(
  options:WebSessionClientRequest,
):Promise<string>{
  const origin=browserApiOrigin(options.baseUrl);
  const response=await (options.fetcher??fetch)(
    origin+'/v1/auth/web/csrf',requestInit(options,'GET'),
  );
  if(!response.ok)return fail(response);
  expectNoContent(response);
  const csrf=response.headers.get('x-folio-csrf');
  if(!csrf||!/^[A-Za-z0-9_-]{43}$/.test(csrf)){
    throw new WebSessionHttpError(204,'INVALID_CSRF_RESPONSE',null);
  }
  return csrf;
}

/** CSRF-verified server revocation and cookie clearing, never local-only logout. */
export async function logoutWebSession(options:WebSessionClientRequest):Promise<void>{
  // HTTPS + exact browser origin is checked before any credentialed request.
  const origin=browserApiOrigin(options.baseUrl);
  const csrf=await fetchWebSessionCsrf(options);
  const response=await (options.fetcher??fetch)(
    origin+'/v1/auth/web/logout',requestInit(options,'POST',{csrf}),
  );
  if(!response.ok)return fail(response);
  expectNoContent(response);
}
