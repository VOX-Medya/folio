import {describe,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {ForbiddenException,ServiceUnavailableException,UnauthorizedException} from '@nestjs/common';
import {
  FOLIO_WEB_SESSION_COOKIE,WEB_SESSION_COOKIE_FLAGS,
  clearWebSessionCookie,issueWebSessionCookie,verifyWebCookieSession,webSessionCsrfToken,
} from './web-cookie-session.js';
import type {WebCookieRequest,WebCookiePolicy} from './web-cookie-session.js';

const bearer=randomBytes(32).toString('base64url');
const principal={userId:'8c9ea723-8e24-4c8a-b2a0-ce1c29262277',
  sessionId:'5dbe842e-31b5-42c8-91eb-f14506033abb'};
const policy:WebCookiePolicy={origin:'https://reader.example.org',csrfKeyHex:'b'.repeat(64)};
const req=(headers:Record<string,string|string[]|undefined>={}):WebCookieRequest=>({
  socket:{encrypted:true},
  headers:{cookie:FOLIO_WEB_SESSION_COOKIE+'='+bearer,...headers},
});
const lookup=async(raw:string)=>raw===bearer?principal:null;
describe('web session transport is isolated from native bearer',()=>{
  it('only issues secure host-only HttpOnly SameSite cookies on TLS',()=>{
    const issued=issueWebSessionCookie(req({origin:policy.origin,'sec-fetch-site':'same-origin'}),bearer,policy);
    expect(issued).toContain(WEB_SESSION_COOKIE_FLAGS);
    expect(issued).toContain('Max-Age=2592000');
    expect(issued).not.toContain('Domain=');
    expect(clearWebSessionCookie(req())).toContain('Max-Age=0');
    expect(()=>issueWebSessionCookie(req({origin:'https://evil.example.org'}),bearer,policy))
      .toThrow(ForbiddenException);
    expect(()=>issueWebSessionCookie({socket:{encrypted:false}},bearer,policy))
      .toThrow(ServiceUnavailableException);
    expect(()=>issueWebSessionCookie(req({origin:policy.origin}),'weak',policy)).toThrow(UnauthorizedException);
  });
  it('creates a key- and session-bound opaque CSRF value',async()=>{
    const one=await webSessionCsrfToken(req(),lookup,policy);
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await webSessionCsrfToken(req(),lookup,policy)).toBe(one);
    expect(await webSessionCsrfToken(req(),lookup,{...policy,csrfKeyHex:'c'.repeat(64)}))
      .not.toBe(one);
    const other=randomBytes(32).toString('base64url');
    expect(await webSessionCsrfToken(req({cookie:FOLIO_WEB_SESSION_COOKIE+'='+other}),async()=>principal,policy))
      .not.toBe(one);
  });
  it('rejects fake X-Forwarded-Proto and missing security policy',async()=>{
    const insecure={...req(),socket:{encrypted:false},headers:{
      ...req().headers,'x-forwarded-proto':'https',
    }};
    await expect(verifyWebCookieSession(insecure,lookup,policy,'GET'))
      .rejects.toThrow(ServiceUnavailableException);
    await expect(verifyWebCookieSession(req(),lookup,{...policy,csrfKeyHex:undefined},'GET'))
      .rejects.toThrow(ServiceUnavailableException);
    for(const origin of ['http://reader.example.org','https://reader.example.org/path',
      'https://reader.example.org/','https://reader.example.org@evil.test']){
      await expect(verifyWebCookieSession(req(),lookup,{...policy,origin},'GET'))
        .rejects.toThrow(ServiceUnavailableException);
    }
  });
  it('rejects duplicate/invalid cookies, mixed bearer auth and spoofed identity',async()=>{
    for(const headers of [
      {cookie:FOLIO_WEB_SESSION_COOKIE+'='+bearer+'; '+FOLIO_WEB_SESSION_COOKIE+'='+bearer},
      {cookie:FOLIO_WEB_SESSION_COOKIE+'=weak'},
      {cookie:'unrelated=something'},
      {authorization:'Bearer '+bearer},
      {cookie:[FOLIO_WEB_SESSION_COOKIE+'='+bearer]},
    ]){
      await expect(verifyWebCookieSession(req(headers),lookup,policy,'GET'))
        .rejects.toThrow(UnauthorizedException);
    }
    expect(await verifyWebCookieSession(req({'x-user-id':'fake','x-admin-role':'admin'}),
      lookup,policy,'GET')).toEqual(principal);
  });
  it('requires exact origin, fetch-site and HMAC token for unsafe methods',async()=>{
    const csrf=await webSessionCsrfToken(req(),lookup,policy);
    const headers={origin:policy.origin!,'sec-fetch-site':'same-origin','x-folio-csrf':csrf};
    for(const bad of [
      {...headers,origin:'https://evil.example.org'},
      {...headers,origin:undefined},
      {...headers,'sec-fetch-site':'cross-site'},
      {...headers,'sec-fetch-site':'same-site'},
      {...headers,'x-folio-csrf':'x'.repeat(43)},
      {...headers,'x-folio-csrf':undefined},
      {...headers,'x-folio-csrf':[csrf]},
    ]){
      await expect(verifyWebCookieSession(req(bad),lookup,policy,'POST'))
        .rejects.toThrow(ForbiddenException);
    }
    expect(await verifyWebCookieSession(req(headers),lookup,policy,'PATCH'))
      .toEqual(principal);
  });
  it('rejects revoked accounts and fails closed when DB lookup fails',async()=>{
    await expect(verifyWebCookieSession(req(),async()=>null,policy,'GET'))
      .rejects.toThrow(UnauthorizedException);
    await expect(verifyWebCookieSession(req(),async()=>{throw Error('DB down');},policy,'GET'))
      .rejects.toThrow(ServiceUnavailableException);
  });
});
