import {
  friendInviteIssueSchema,friendInviteIssuedSchema,friendInviteRedeemSchema,
  friendRequestResultSchema,friendshipActionSchema,friendshipDecisionResultSchema,
  friendshipListSchema,
} from './friendship.js';
import type {FriendInviteIssued,FriendRequestResult,FriendshipAction,FriendshipDecisionResult,FriendshipList} from './friendship.js';
import {fetchWebSessionCsrf,WebSessionHttpError} from './web-session-client.js';

type Options={fetcher?:typeof fetch;signal?:AbortSignal};
function origin(raw:string):string{
  if(typeof window==='undefined'||typeof document==='undefined')throw Error('Browser HTTPS required');
  let url:URL;
  try{url=new URL(raw);}catch{throw Error('Configured HTTPS origin required');}
  if(url.protocol!=='https:'||url.origin!==raw||url.pathname!=='/'||url.search||url.hash||
    url.username||url.password||window.location.origin!==url.origin){
    throw Error('Same-origin HTTPS friendship required');
  }
  return url.origin;
}
function init(method:'GET'|'POST',signal?:AbortSignal,csrf?:string,body?:string):RequestInit{
  return {method,mode:'same-origin',credentials:'same-origin',cache:'no-store',
    redirect:'error',referrerPolicy:'no-referrer',
    headers:{accept:'application/json',...(csrf?{'x-folio-csrf':csrf}:{}),
      ...(body?{'content-type':'application/json'}:{})},
    ...(body?{body}:{}),...(signal?{signal}:{}),
  };
}
async function parse<T>(response:Response,schema:{parse:(raw:unknown)=>T}):Promise<T>{
  if(!response.ok)throw new WebSessionHttpError(response.status,'FRIENDSHIP_DENIED',null);
  if(response.status!==200)throw new WebSessionHttpError(response.status,'INVALID_FRIENDSHIP_RESPONSE',null);
  let value:unknown;
  try{value=await response.json();}catch{throw new WebSessionHttpError(200,'INVALID_FRIENDSHIP_RESPONSE',null);}
  try{return schema.parse(value);}
  catch{throw new WebSessionHttpError(200,'INVALID_FRIENDSHIP_RESPONSE',null);}
}
async function post<T>(base:string,path:string,input:unknown,
  schema:{parse:(value:unknown)=>T},options?:Options):Promise<T>{
  const url=origin(base);
  const csrf=await fetchWebSessionCsrf({baseUrl:url,
    ...(options?.fetcher?{fetcher:options.fetcher}:{}),
    ...(options?.signal?{signal:options.signal}:{}),
  });
  const response=await (options?.fetcher??fetch)(url+path,
    init('POST',options?.signal,csrf,JSON.stringify(input)));
  return parse(response,schema);
}
/** Owner-only: no endpoint takes peer IDs, account names, or emails. */
export async function fetchOwnWebFriendships(base:string,options?:Options):Promise<FriendshipList>{
  const url=origin(base);
  const response=await (options?.fetcher??fetch)(url+'/v1/me/friends',
    init('GET',options?.signal));
  return parse(response,friendshipListSchema);
}
export function rotateOwnWebFriendInvite(base:string,options?:Options):Promise<FriendInviteIssued>{
  return post(base,'/v1/me/friends/invite',friendInviteIssueSchema.parse({rotate:true}),
    friendInviteIssuedSchema,options);
}
export function requestOwnWebFriendship(base:string,raw:unknown,options?:Options):Promise<FriendRequestResult>{
  return post(base,'/v1/me/friends/request',friendInviteRedeemSchema.parse(raw),
    friendRequestResultSchema,options);
}
export function decideOwnWebFriendship(base:string,raw:FriendshipAction,options?:Options):
  Promise<FriendshipDecisionResult>{
  return post(base,'/v1/me/friends/decision',friendshipActionSchema.parse(raw),
    friendshipDecisionResultSchema,options);
}
