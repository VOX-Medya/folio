import {
  capabilityPageSchema,cursorQuerySchema,healthResponseSchema,readinessResponseSchema,
} from './index.js';
import type {CapabilityPage,HealthResponse,ReadinessResponse} from './index.js';
import {readFolioError,verifiedApiOrigin} from './verified-request.js';

/**
 * Shared, unauthenticated V1 system transport for admin/Web/React Native.
 * These are public status probes, NOT proof that an owner/admin is signed in.
 * Never attach a browser session or silently follow a redirect to another host.
 */
export class SystemHttpError extends Error {
  constructor(
    readonly status:number,readonly code:string,readonly requestId:string|null,
  ){
    super('System API request failed: '+code);
    this.name='SystemHttpError';
  }
}
async function readSystem(
  baseUrl:string,path:string,fetcher:typeof fetch,
):Promise<unknown>{
  // Validate BEFORE network access. Only HTTPS, or explicit local loopback
  // HTTP for isolated development/testing. No path/query/userinfo/fragment.
  const origin=verifiedApiOrigin(baseUrl);
  const response=await fetcher(origin+path,{
    method:'GET',
    credentials:'omit',
    cache:'no-store',
    redirect:'error',
    referrerPolicy:'no-referrer',
    headers:{accept:'application/json'},
  });
  if(response.status!==200){
    if(!response.ok){
      const {code,requestId}=await readFolioError(response);
      throw new SystemHttpError(response.status,code,requestId);
    }
    throw new SystemHttpError(response.status,'UNEXPECTED_HTTP_RESPONSE',null);
  }
  try{return await response.json() as unknown;}
  catch{throw new SystemHttpError(200,'INVALID_SYSTEM_RESPONSE',null);}
}
function parseSystem<T>(
  raw:unknown,parse:(raw:unknown)=>T,
):T {
  try{return parse(raw);}
  catch{throw new SystemHttpError(200,'INVALID_SYSTEM_RESPONSE',null);}
}

/** Process liveness only. A healthy process does not mean DB/jobs are ready. */
export async function fetchSystemHealth(
  baseUrl:string,fetcher:typeof fetch=fetch,
):Promise<HealthResponse>{
  const data=await readSystem(baseUrl,'/v1/health',fetcher);
  return parseSystem(data,raw=>healthResponseSchema.parse(raw));
}

/** Database readiness only; a 503 is a typed failure, never a fake ready flag. */
export async function fetchSystemReadiness(
  baseUrl:string,fetcher:typeof fetch=fetch,
):Promise<ReadinessResponse>{
  const data=await readSystem(baseUrl,'/v1/ready',fetcher);
  return parseSystem(data,raw=>readinessResponseSchema.parse(raw));
}

/** Strict, bounded cursor client with canonical query encoding. */
export async function fetchCapabilities(
  baseUrl:string,query:{limit?:number;cursor?:string}={},
  fetcher:typeof fetch=fetch,
):Promise<CapabilityPage>{
  // Validate the full input shape before sending a single HTTP request.
  const parsed=cursorQuerySchema.safeParse(query);
  if(!parsed.success)throw new Error('Invalid pagination parameters');
  const params=new URLSearchParams();
  if(query.limit!==undefined)params.set('limit',String(parsed.data.limit));
  if(query.cursor!==undefined&&parsed.data.cursor!==undefined){
    params.set('cursor',parsed.data.cursor);
  }
  const suffix=params.size?'?'+params.toString():'';
  const data=await readSystem(baseUrl,'/v1/system/capabilities'+suffix,fetcher);
  return parseSystem(data,raw=>capabilityPageSchema.parse(raw));
}
