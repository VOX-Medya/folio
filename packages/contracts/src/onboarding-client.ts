import {
  apiErrorSchema,onboardingSnapshotSchema,onboardingUpdateRequestSchema,
} from './index.js';
import type {OnboardingSnapshot} from './index.js';

/**
 * Stateless cross-platform client. The caller supplies an already verified
 * bearer from its platform security boundary. Never persist a token here.
 */
export interface OwnOnboardingRequest {
  baseUrl:string;
  bearerToken:string;
  fetcher?:typeof fetch;
  signal?:AbortSignal;
}
export class OnboardingHttpError extends Error {
  constructor(
    readonly status:number,readonly code:string,readonly requestId:string|null,
  ){
    super('Onboarding request failed: '+code);
    this.name='OnboardingHttpError';
  }
}
export class OnboardingVersionConflictError extends OnboardingHttpError {
  constructor(requestId:string|null){
    super(409,'CONFLICT',requestId);
    this.name='OnboardingVersionConflictError';
  }
}
function ownEndpoint(baseUrl:string):string{
  const url=new URL(baseUrl);
  const secure=url.protocol==='https:';
  const local=url.protocol==='http:'&&
    (url.hostname==='localhost'||url.hostname==='127.0.0.1'||url.hostname==='[::1]');
  if((!secure&&!local)||url.username||url.password||
    (url.pathname!=='/'&&url.pathname!=='')||url.search||url.hash){
    throw new Error('A secure API origin is required');
  }
  return url.origin+'/v1/me/onboarding';
}
function bearerHeader(raw:string):string{
  if(!/^[A-Za-z0-9_-]{43}$/.test(raw)){
    throw new Error('A verified bearer session is required');
  }
  return 'Bearer '+raw;
}
async function errorFromResponse(response:Response):Promise<never>{
  let data:unknown;
  try{data=await response.json();}
  catch{data=null;}
  const parsed=apiErrorSchema.safeParse(data);
  const code=parsed.success?parsed.data.error.code:'UNEXPECTED_HTTP_RESPONSE';
  const requestId=parsed.success?parsed.data.error.requestId:null;
  if(response.status===409&&code==='CONFLICT'){
    throw new OnboardingVersionConflictError(requestId);
  }
  throw new OnboardingHttpError(response.status,code,requestId);
}
async function request(
  options:OwnOnboardingRequest,method:'GET'|'PATCH',body?:unknown,
):Promise<OnboardingSnapshot>{
  const endpoint=ownEndpoint(options.baseUrl);
  const authorization=bearerHeader(options.bearerToken);
  const init:RequestInit={
    method,
    credentials:'omit',
    cache:'no-store',
    headers:{
      authorization,
      accept:'application/json',
      ...(method==='PATCH'?{'content-type':'application/json'}:{}),
    },
    ...(method==='PATCH'?{body:JSON.stringify(body)}:{}),
    ...(options.signal?{signal:options.signal}:{}),
  };
  const response=await (options.fetcher??fetch)(endpoint,init);
  if(!response.ok)return errorFromResponse(response);
  let raw:unknown;
  try{raw=await response.json();}
  catch{throw new Error('Invalid onboarding response payload');}
  return onboardingSnapshotSchema.parse(raw);
}
/** Loads only the bearer account's server-owned progress. */
export async function fetchOwnOnboarding(
  options:OwnOnboardingRequest,
):Promise<OnboardingSnapshot>{
  return request(options,'GET');
}
/** Persist exactly one optimistic version update; 409 requires server reload. */
export async function updateOwnOnboarding(
  options:OwnOnboardingRequest,rawUpdate:unknown,
):Promise<OnboardingSnapshot>{
  const input=onboardingUpdateRequestSchema.parse(rawUpdate);
  return request(options,'PATCH',input);
}
