import {describe,expect,it} from 'vitest';
import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {assertSafeWebCsrfBootstrap,assertSafeWebLoginRequest} from './web-cookie-session.js';
import type {WebCookiePolicy,WebCookieRequest} from './web-cookie-session.js';
const policy:WebCookiePolicy={origin:'https://reader.example.org',csrfKeyHex:'e'.repeat(64)};
const direct=(headers:Record<string,string|string[]|undefined>):WebCookieRequest=>({
  socket:{encrypted:true},headers,
});
describe('web login transport rejects session fixation and cross-site CSRF bootstrap',()=>{
  it('requires true TLS and exact origin BEFORE password or quota',()=>{
    expect(()=>assertSafeWebLoginRequest(direct({
      origin:policy.origin,'sec-fetch-site':'same-origin',
    }),policy)).not.toThrow();
    for(const headers of [
      {origin:'https://attacker.example.org'},
      {'sec-fetch-site':'same-origin'},
      {origin:policy.origin,'sec-fetch-site':'cross-site'},
      {origin:policy.origin,cookie:'old=123'},
      {origin:policy.origin,authorization:'Bearer attacker'},
    ]){
      expect(()=>assertSafeWebLoginRequest(direct(headers),policy)).toThrow();
    }
    expect(()=>assertSafeWebLoginRequest({
      socket:{encrypted:false},
      headers:{origin:policy.origin,'x-forwarded-proto':'https'},
    },policy)).toThrow(ServiceUnavailableException);
    expect(()=>assertSafeWebLoginRequest(direct({origin:policy.origin}),
      {...policy,csrfKeyHex:undefined})).toThrow(ServiceUnavailableException);
  });
  it('blocks cross-site CSRF token bootstrap even for an otherwise valid cookie',()=>{
    expect(()=>assertSafeWebCsrfBootstrap(direct({'sec-fetch-site':'same-origin'}),
      policy)).not.toThrow();
    for(const headers of [
      {origin:'https://attacker.example.org'},
      {'sec-fetch-site':'cross-site'},
      {'sec-fetch-site':'same-site'},
    ]){
      expect(()=>assertSafeWebCsrfBootstrap(direct(headers),policy))
        .toThrow(ForbiddenException);
    }
  });
});
