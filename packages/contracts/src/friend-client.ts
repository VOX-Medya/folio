import {
  friendInviteCodeSchema,friendRequestInputSchema,friendOperationResultSchema,
  friendListSchema,
} from './index.js';
import type {FriendList} from './index.js';
import {fetchWebSessionCsrf,WebSessionHttpError} from './web-session-client.js';

type Options={fetcher?:typeof fetch;signal?:AbortSignal};
function origin(raw:string):string{
  if(typeof window==='undefined')throw Error('HTTPS browser required');
  let url:URL;
  try{url=new URL(raw);}catch{throw Error('Invalid HTTPS origin');}
  if(url.protocol!=='https:'||url.origin!==raw||url.pathname!=='/'||
    url.search||url.hash||url.username||url.password||
    window.location.origin!==url.origin){
    throw Error('Same-origin HTTPS required');
  }
  return url.origin;
}
async function parse<T>(response:Response,schema:{parse:(raw:unknown)=>T}):Promise<T>{
  if(!response.ok)throw new WebSessionHttpError(response.status,'FRIEND_REQUEST_DENIED',null);
  if(response.status!==200)throw new WebSessionHttpError(response.status,'INVALID_FRIEND_RESPONSE',null);
  let raw:unknown;
  try{raw=await response.json();}catch{throw new WebSessionHttpError(200,'INVALID_FRIEND_RESPONSE',null);}
  try{return schema.parse(raw);}
  catch{throw new WebSessionHttpError(200,'INVALID_FRIEND_RESPONSE',null);}
}
function init(method:'GET'|'POST',csrf?:string,body?:string,signal?:AbortSignal):RequestInit{
  return {method,mode:'same-origin',credentials:'same-origin',cache:'no-store',
    redirect:'error',referrerPolicy:'no-referrer',
    headers:{accept:'application/json',...(csrf?{'x-folio-csrf':csrf}:{}),
      ...(body?{'content-type':'application/json'}:{})},
    ...(body?{body}:{}),...(signal?{signal}:{}),
  };
}
async function csrf(base:string,options?:Options){
  return fetchWebSessionCsrf({baseUrl:base,
    ...(options?.fetcher?{fetcher:options.fetcher}:{}),
    ...(options?.signal?{signal:options.signal}:{}),
  });
}
export async function fetchOwnFriends(baseUrl:string,options?:Options):Promise<FriendList>{
  const base=origin(baseUrl);
  const response=await (options?.fetcher??fetch)(base+'/v1/me/friends',
    init('GET',undefined,undefined,options?.signal));
  return parse(response,friendListSchema);
}
export async function rotateOwnFriendInvite(baseUrl:string,options?:Options){
  const base=origin(baseUrl),token=await csrf(base,options);
  const response=await (options?.fetcher??fetch)(base+'/v1/me/friends/invite',
    init('POST',token,undefined,options?.signal));
  return parse(response,friendInviteCodeSchema);
}
export async function sendOwnFriendRequest(baseUrl:string,input:unknown,options?:Options){
  const base=origin(baseUrl),data=friendRequestInputSchema.parse(input);
  const token=await csrf(base,options);
  const response=await (options?.fetcher??fetch)(base+'/v1/me/friends/requests',
    init('POST',token,JSON.stringify(data),options?.signal));
  return parse(response,friendOperationResultSchema);
}
export async function acceptOwnFriend(baseUrl:string,rawPeerId:unknown,options?:Options){
  const base=origin(baseUrl),peerId=friendListSchema.shape.items.element.shape.peerId.parse(rawPeerId);
  const token=await csrf(base,options);
  const response=await (options?.fetcher??fetch)(
    base+'/v1/me/friends/'+encodeURIComponent(peerId)+'/accept',
    init('POST',token,undefined,options?.signal));
  return parse(response,friendOperationResultSchema);
}
export async function blockOwnFriend(baseUrl:string,rawPeerId:unknown,options?:Options){
  const base=origin(baseUrl),peerId=friendListSchema.shape.items.element.shape.peerId.parse(rawPeerId);
  const token=await csrf(base,options);
  const response=await (options?.fetcher??fetch)(
    base+'/v1/me/friends/'+encodeURIComponent(peerId)+'/block',
    init('POST',token,undefined,options?.signal));
  return parse(response,friendOperationResultSchema);
}
