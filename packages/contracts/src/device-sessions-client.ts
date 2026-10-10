import {deviceSessionIdSchema,deviceSessionInventorySchema} from './index.js';
import type {DeviceSessionInventory} from './index.js';
import {readFolioError,verifiedApiOrigin,verifiedBearerHeader} from './verified-request.js';

/** Stateless. Caller manages a previously verified bearer in platform-specific secure storage. */
export interface OwnDeviceSessionsRequest{
  baseUrl:string;
  bearerToken:string;
  fetcher?:typeof fetch;
  signal?:AbortSignal;
}
export class DeviceSessionHttpError extends Error{
  constructor(
    readonly status:number,readonly code:string,readonly requestId:string|null,
  ){
    super('Device session request failed: '+code);
    this.name='DeviceSessionHttpError';
  }
}
async function sessionError(response:Response):Promise<never>{
  const {code,requestId}=await readFolioError(response);
  throw new DeviceSessionHttpError(response.status,code,requestId);
}
function sessionRequest(options:OwnDeviceSessionsRequest,method:'GET'|'DELETE'){
  const base=verifiedApiOrigin(options.baseUrl);
  const authorization=verifiedBearerHeader(options.bearerToken);
  const init:RequestInit={
    method,credentials:'omit',cache:'no-store',redirect:'error',
    headers:{authorization,accept:'application/json'},
    ...(options.signal?{signal:options.signal}:{}),
  };
  return {base,init,fetcher:options.fetcher??fetch};
}

/** Gets active sessions for the verified bearer owner, never another user ID. */
export async function fetchOwnDeviceSessions(
  options:OwnDeviceSessionsRequest,
):Promise<DeviceSessionInventory>{
  const {base,init,fetcher}=sessionRequest(options,'GET');
  const response=await fetcher(base+'/v1/me/sessions',init);
  if(!response.ok)return sessionError(response);
  let data:unknown;
  try{data=await response.json();}
  catch{throw new Error('Invalid device session response');}
  return deviceSessionInventorySchema.parse(data);
}

/** Revoke one owner-bound device session; HTTP 204 is required, with no response body. */
export async function revokeOwnDeviceSession(
  options:OwnDeviceSessionsRequest,rawSessionId:unknown,
):Promise<void>{
  // Validate BEFORE network and before sending the bearer token.
  const id=deviceSessionIdSchema.parse(rawSessionId);
  const {base,init,fetcher}=sessionRequest(options,'DELETE');
  const response=await fetcher(base+'/v1/me/sessions/'+encodeURIComponent(id),init);
  if(response.status===204)return;
  if(!response.ok)return sessionError(response);
  throw new DeviceSessionHttpError(response.status,'UNEXPECTED_HTTP_RESPONSE',null);
}
