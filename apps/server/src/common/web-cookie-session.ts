import {createHmac,timingSafeEqual} from 'node:crypto';
import {
  ForbiddenException,ServiceUnavailableException,UnauthorizedException,
} from '@nestjs/common';
import type {BearerSessionLookup,SessionPrincipal} from './session-auth.js';

export const FOLIO_WEB_SESSION_COOKIE='__Host-folio_session';
const bearerPattern=/^[A-Za-z0-9_-]{43}$/;
const csrfPattern=/^[A-Za-z0-9_-]{43}$/;
export const WEB_SESSION_COOKIE_FLAGS='Path=/; Secure; HttpOnly; SameSite=Strict';
export const WEB_SESSION_MAX_AGE_SECONDS=30*24*60*60;

export interface WebCookieRequest {
  headers?:Record<string,string|string[]|undefined>;
  // Actual HTTPS transport only. Never rely on Express req.secure or
  // spoofable X-Forwarded-Proto before an independently audited proxy boundary.
  socket?:{encrypted?:boolean|undefined};
}
export interface WebCookiePolicy {
  origin:string|undefined;
  csrfKeyHex:string|undefined;
}

function requireHttps(request:WebCookieRequest):void {
  if(request.socket?.encrypted!==true){
    throw new ServiceUnavailableException('Verified HTTPS transport required');
  }
}

function originOf(raw:string|undefined):string {
  if(!raw||raw.length>256)throw new ServiceUnavailableException('Web origin unavailable');
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.origin!==raw||url.username||url.password||
       url.pathname!=='/'||url.search||url.hash){
      throw new Error('Unexpected origin');
    }
    return url.origin;
  }catch{
    throw new ServiceUnavailableException('Web origin unavailable');
  }
}
function csrfSecret(raw:string|undefined):Buffer {
  if(!raw||!/^[a-fA-F0-9]{64}$/.test(raw)){
    throw new ServiceUnavailableException('Web CSRF protection unavailable');
  }
  return Buffer.from(raw,'hex');
}
function verifiedToken(raw:string):string {
  if(!bearerPattern.test(raw))throw new UnauthorizedException('Verified session required');
  return raw;
}

/**
 * Validate origin, TLS and absence of already-present credentials BEFORE
 * performing any rate-limit accounting, password hash or session creation.
 * Login CSRF does not use the session CSRF header since no session exists yet.
 */
export function assertSafeWebLoginRequest(request:WebCookieRequest,policy:WebCookiePolicy):void{
  requireHttps(request);
  const allowed=originOf(policy.origin);
  csrfSecret(policy.csrfKeyHex);
  if(request.headers?.origin!==allowed||
     (request.headers?.['sec-fetch-site']!==undefined&&
      request.headers['sec-fetch-site']!=='same-origin')){
    throw new ForbiddenException('Web login origin denied');
  }
  if(request.headers?.cookie!==undefined||request.headers?.authorization!==undefined){
    throw new UnauthorizedException('Existing authentication transport forbidden on login');
  }
}

/** Set only AFTER DB-verified web sign-in on a genuine HTTPS connection. */
export function issueWebSessionCookie(
  request:WebCookieRequest,rawBearer:string,policy:WebCookiePolicy,
):string {
  requireHttps(request);
  const allowed=originOf(policy.origin);
  csrfSecret(policy.csrfKeyHex);
  if(request.headers?.origin!==allowed||
     (request.headers?.['sec-fetch-site']!==undefined&&
       request.headers['sec-fetch-site']!=='same-origin')){
    throw new ForbiddenException('Web login origin denied');
  }
  const bearer=verifiedToken(rawBearer);
  return [FOLIO_WEB_SESSION_COOKIE+'='+bearer,WEB_SESSION_COOKIE_FLAGS,
    'Max-Age='+WEB_SESSION_MAX_AGE_SECONDS].join('; ');
}
export function clearWebSessionCookie(request:WebCookieRequest):string {
  requireHttps(request);
  return [FOLIO_WEB_SESSION_COOKIE+'=',WEB_SESSION_COOKIE_FLAGS,'Max-Age=0'].join('; ');
}
function cookieBearer(request:WebCookieRequest):string {
  const raw=request.headers?.cookie;
  // Cookie, not Authorization, is the ONLY credential in this flow.
  if(typeof request.headers?.authorization!=='undefined'||
     typeof raw!=='string'||raw.length>4096){
    throw new UnauthorizedException('Verified web session required');
  }
  let found:string|undefined;
  for(const pair of raw.split(';')){
    const text=pair.trim();
    const split=text.indexOf('=');
    if(split<0||text.slice(0,split)!==FOLIO_WEB_SESSION_COOKIE)continue;
    if(found!==undefined)throw new UnauthorizedException('Ambiguous web session cookie');
    found=text.slice(split+1);
  }
  if(!found||!bearerPattern.test(found)){
    throw new UnauthorizedException('Verified web session required');
  }
  return found;
}
function csrfValue(rawBearer:string,policy:WebCookiePolicy):string {
  const key=csrfSecret(policy.csrfKeyHex);
  return createHmac('sha256',key).update('folio.web.csrf.v1\0')
    .update(rawBearer,'ascii').digest('base64url');
}
/**
 * A synchronizer token returned only by a verified same-origin session
 * bootstrap. Not a cookie, not in localStorage, and never logged/audited.
 */
export async function webSessionCsrfToken(
  request:WebCookieRequest,lookup:BearerSessionLookup,policy:WebCookiePolicy,
):Promise<string> {
  // Enforce same-origin proof in the token issuer itself, not only callers.
  assertSafeWebCsrfBootstrap(request,policy);
  await verifyWebCookieSession(request,lookup,policy,'GET');
  return csrfValue(cookieBearer(request),policy);
}

/**
 * INTERNAL ONLY: future web routes can opt in to this exact cookie transport,
 * distinct from native Authorization bearer endpoints.
 *
 * Every call verifies a hashed bearer against the current DB (including revoked
 * and disabled states); unsafe methods additionally require exact Origin,
 * optional Sec-Fetch-Site same-origin, and constant-time HMAC CSRF check.
 */
export async function verifyWebCookieSession(
  request:WebCookieRequest,
  lookup:BearerSessionLookup,
  policy:WebCookiePolicy,
  method:string,
):Promise<SessionPrincipal> {
  requireHttps(request);
  const expectedOrigin=originOf(policy.origin);
  csrfSecret(policy.csrfKeyHex);
  const bearer=cookieBearer(request);
  const verb=method.toUpperCase();
  const unsafe=!['GET','HEAD','OPTIONS'].includes(verb);
  if(unsafe){
    if(request.headers?.origin!==expectedOrigin){
      throw new ForbiddenException('Web request origin denied');
    }
    const site=request.headers?.['sec-fetch-site'];
    if(site!==undefined&&site!=='same-origin'){
      throw new ForbiddenException('Cross-origin web request denied');
    }
    const received=request.headers?.['x-folio-csrf'];
    if(typeof received!=='string'||!csrfPattern.test(received)){
      throw new ForbiddenException('Web CSRF token required');
    }
    const expected=csrfValue(bearer,policy);
    if(!timingSafeEqual(Buffer.from(received,'ascii'),Buffer.from(expected,'ascii'))){
      throw new ForbiddenException('Web CSRF token invalid');
    }
  }
  try {
    const principal=await lookup(bearer);
    if(!principal?.userId||!principal.sessionId){
      throw new UnauthorizedException('Verified web session required');
    }
    return {userId:principal.userId,sessionId:principal.sessionId};
  }catch(error){
    if(error instanceof UnauthorizedException)throw error;
    throw new ServiceUnavailableException('Web session verification unavailable');
  }
}

/** CSRF bootstrap cannot become a cross-site readable token endpoint. */
export function assertSafeWebCsrfBootstrap(request:WebCookieRequest,policy:WebCookiePolicy):void{
  requireHttps(request);
  const allowed=originOf(policy.origin);
  csrfSecret(policy.csrfKeyHex);
  const rawOrigin=request.headers?.origin;
  const fetchSite=request.headers?.['sec-fetch-site'];
  // A cookie alone is not an origin proof. Modern same-origin browser fetches
  // supply Sec-Fetch-Site; exact Origin is an acceptable alternate signal.
  // Reject clients that omit both rather than exposing the CSRF bootstrap to
  // arbitrary credentialed requests with no origin context.
  if((rawOrigin===undefined&&fetchSite===undefined)||
     (rawOrigin!==undefined&&rawOrigin!==allowed)||
     (fetchSite!==undefined&&fetchSite!=='same-origin')){
    throw new ForbiddenException('Cross-origin CSRF bootstrap denied');
  }
}
