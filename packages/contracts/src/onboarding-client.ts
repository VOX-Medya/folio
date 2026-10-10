import {
  onboardingSnapshotSchema,onboardingUpdateRequestSchema,
} from './index.js';
import type {OnboardingSnapshot} from './index.js';
import {verifiedApiOrigin,verifiedBearerHeader,readFolioError} from './verified-request.js';

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
  return verifiedApiOrigin(baseUrl)+'/v1/me/onboarding';
}
async function errorFromResponse(response:Response):Promise<never>{
  const {code,requestId}=await readFolioError(response);
  if(response.status===409&&code==='CONFLICT'){
    throw new OnboardingVersionConflictError(requestId);
  }
  throw new OnboardingHttpError(response.status,code,requestId);
}
async function request(
  options:OwnOnboardingRequest,method:'GET'|'PATCH',body?:unknown,
):Promise<OnboardingSnapshot>{
  const endpoint=ownEndpoint(options.baseUrl);
  const authorization=verifiedBearerHeader(options.bearerToken);
  const init:RequestInit={
    method,
    credentials:'omit',
    cache:'no-store',
    redirect:'error',
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
