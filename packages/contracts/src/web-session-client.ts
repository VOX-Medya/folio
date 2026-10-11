import {
  deviceSessionIdSchema,deviceSessionInventorySchema,webLoginRequestSchema,
  webRegisterRequestSchema,webVerifyEmailRequestSchema,
  onboardingSnapshotSchema,onboardingUpdateRequestSchema,
} from './index.js';
import type {DeviceSessionInventory,OnboardingSnapshot} from './index.js';
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
  options:WebSessionClientRequest,method:'GET'|'POST'|'DELETE'|'PATCH',
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
 * A remote device may revoke this browser cookie between requests. The
 * server's same-origin HTTPS CSRF bootstrap retires revoked/disabled cookies
 * with Set-Cookie Max-Age=0 on 401. Probe exactly once, without retrying any
 * protected operation or hiding the original 401 response.
 */
async function failDeviceSession(
  response:Response,options:WebSessionClientRequest,
):Promise<never>{
  if(response.status===401){
    try{await fetchWebSessionCsrf(options);}
    catch{/* A revoked cookie yields 401; keep the original device error. */}
  }
  return fail(response);
}

/** Unauthenticated registration sends only credentials. NEVER accepts a token in JSON. */
export async function registerWebAccount(
  options:WebSessionClientRequest,raw:unknown,
):Promise<void>{
  const origin=browserApiOrigin(options.baseUrl);
  const data=webRegisterRequestSchema.parse(raw);
  const response=await (options.fetcher??fetch)(origin+'/v1/auth/web/register',
    requestInit(options,'POST',{body:JSON.stringify(data)}));
  if(!response.ok)return fail(response);
  if(response.status!==202)throw new WebSessionHttpError(
    response.status,'UNEXPECTED_HTTP_RESPONSE',null);
}

/** Email verification code is submitted through a POST body, never a URL. */
export async function verifyWebAccountEmail(
  options:WebSessionClientRequest,raw:unknown,
):Promise<void>{
  const origin=browserApiOrigin(options.baseUrl);
  const data=webVerifyEmailRequestSchema.parse(raw);
  const response=await (options.fetcher??fetch)(origin+'/v1/auth/web/verify-email',
    requestInit(options,'POST',{body:JSON.stringify(data)}));
  if(!response.ok)return fail(response);
  expectNoContent(response);
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

/**
 * Read only the authenticated browser cookie owner's active device inventory.
 * A strict response schema rejects leaked tokens, emails or unknown fields.
 */
export async function fetchWebDeviceSessions(
  options:WebSessionClientRequest,
):Promise<DeviceSessionInventory>{
  const origin=browserApiOrigin(options.baseUrl);
  const response=await (options.fetcher??fetch)(
    origin+'/v1/me/sessions',requestInit(options,'GET'),
  );
  if(!response.ok)return failDeviceSession(response,options);
  if(response.status!==200){
    throw new WebSessionHttpError(response.status,'UNEXPECTED_HTTP_RESPONSE',null);
  }
  let data:unknown;
  try{data=await response.json();}
  catch{throw new WebSessionHttpError(200,'INVALID_SESSION_RESPONSE',null);}
  const parsed=deviceSessionInventorySchema.safeParse(data);
  if(!parsed.success){
    throw new WebSessionHttpError(200,'INVALID_SESSION_RESPONSE',null);
  }
  return parsed.data;
}

/**
 * Revoke exactly one owned session over same-origin HTTPS with fresh CSRF.
 * The UUID is validated before any network request or session information flows.
 */
export async function revokeWebDeviceSession(
  options:WebSessionClientRequest,rawSessionId:unknown,
):Promise<void>{
  const origin=browserApiOrigin(options.baseUrl);
  const id=deviceSessionIdSchema.parse(rawSessionId);
  const csrf=await fetchWebSessionCsrf(options);
  const response=await (options.fetcher??fetch)(
    origin+'/v1/me/sessions/'+encodeURIComponent(id),
    requestInit(options,'DELETE',{csrf}),
  );
  if(!response.ok)return failDeviceSession(response,options);
  expectNoContent(response);
}

/**
 * Retrieve only the verified browser session owner's persisted onboarding.
 * No user ID, account data, or bearer is sent by the caller.
 */
export async function fetchWebOnboarding(
  options:WebSessionClientRequest,
):Promise<OnboardingSnapshot>{
  const origin=browserApiOrigin(options.baseUrl);
  const response=await (options.fetcher??fetch)(
    origin+'/v1/me/onboarding',requestInit(options,'GET'),
  );
  return parseWebOnboarding(response,options);
}

/** Strict 200 contract for a verified, backend-owned onboarding snapshot. */
async function parseWebOnboarding(
  response:Response,options:WebSessionClientRequest,
):Promise<OnboardingSnapshot>{
  if(!response.ok)return failDeviceSession(response,options);
  if(response.status!==200){
    throw new WebSessionHttpError(response.status,'UNEXPECTED_HTTP_RESPONSE',null);
  }
  let raw:unknown;
  try{raw=await response.json();}
  catch{throw new WebSessionHttpError(200,'INVALID_ONBOARDING_RESPONSE',null);}
  const parsed=onboardingSnapshotSchema.safeParse(raw);
  if(!parsed.success){
    throw new WebSessionHttpError(200,'INVALID_ONBOARDING_RESPONSE',null);
  }
  return parsed.data;
}

/**
 * Advance exactly one server-checked optimistic stage. Schema and origin are
 * validated before network access. Fresh per-session CSRF is required for
 * every mutation; stale versions return a 409, never silent local success.
 */
export async function updateWebOnboarding(
  options:WebSessionClientRequest,rawUpdate:unknown,
):Promise<OnboardingSnapshot>{
  const origin=browserApiOrigin(options.baseUrl);
  const input=onboardingUpdateRequestSchema.parse(rawUpdate);
  const csrf=await fetchWebSessionCsrf(options);
  const response=await (options.fetcher??fetch)(
    origin+'/v1/me/onboarding',
    requestInit(options,'PATCH',{csrf,body:JSON.stringify(input)}),
  );
  return parseWebOnboarding(response,options);
}
