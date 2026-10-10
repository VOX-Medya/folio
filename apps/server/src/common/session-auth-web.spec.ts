import {describe,expect,it} from 'vitest';
import {ForbiddenException,ServiceUnavailableException,UnauthorizedException} from '@nestjs/common';
import type {ExecutionContext} from '@nestjs/common';
import {webSessionCsrfToken} from './web-cookie-session.js';
import {VerifiedSelfSessionGuard} from './session-auth.js';

const raw='A'.repeat(43);
const identity={userId:'8c9ea723-8e24-4c8a-b2a0-ce1c29262277',
  sessionId:'5dbe842e-31b5-42c8-91eb-f14506033abb'};
const policy={origin:'https://reader.example.org',csrfKeyHex:'d'.repeat(64)};
const lookup=async (token:string)=>token===raw?identity:null;
type MockReq={
  method:string;headers:Record<string,string>;socket:{encrypted:boolean};
  auth?:{userId:string;sessionId:string};
};
const ctx=(request:MockReq)=>({
  switchToHttp:()=>({getRequest:()=>request}),
}) as unknown as ExecutionContext;
const headers={cookie:'__Host-folio_session='+raw,'sec-fetch-site':'same-origin'};
function request(method='GET',override:Record<string,string>={}):MockReq{
  return {method,headers:{...headers,...override},socket:{encrypted:true}};
}
describe('owner-self guard Web cookie / native bearer separation',()=>{
  it('preserves native bearer when web mode is disabled and refuses cookie',async()=>{
    const prev=process.env.FOLIO_WEB_AUTH_MODE;
    try{
      delete process.env.FOLIO_WEB_AUTH_MODE;
      const native={method:'GET',headers:{authorization:'Bearer '+raw},
        socket:{encrypted:false},
        auth:{userId:'fake',sessionId:'fake'}};
      const guard=new VerifiedSelfSessionGuard(lookup);
      await expect(guard.canActivate(ctx(native))).resolves.toBe(true);
      expect(native.auth).toEqual(identity);
      await expect(guard.canActivate(ctx(request()))).rejects.toThrow(UnauthorizedException);
    }finally{
      if(prev===undefined)delete process.env.FOLIO_WEB_AUTH_MODE;
      else process.env.FOLIO_WEB_AUTH_MODE=prev;
    }
  });
  it('validates TLS and same-origin request on cookie GET and HMAC on unsafe methods',async()=>{
    const original=Object.fromEntries([
      'FOLIO_WEB_AUTH_MODE','FOLIO_WEB_AUTH_ORIGIN','FOLIO_WEB_CSRF_KEY_HEX',
    ].map(x=>[x,process.env[x]]));
    try{
      process.env.FOLIO_WEB_AUTH_MODE='direct-tls-only';
      process.env.FOLIO_WEB_AUTH_ORIGIN=policy.origin;
      process.env.FOLIO_WEB_CSRF_KEY_HEX=policy.csrfKeyHex;
      const guard=new VerifiedSelfSessionGuard(lookup);
      const get=request();
      await expect(guard.canActivate(ctx(get))).resolves.toBe(true);
      expect(get.auth).toEqual(identity);
      await expect(guard.canActivate(ctx(request('GET',{
        origin:'https://attacker.example.org',
      })))).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(ctx(request('GET',{
        'sec-fetch-site':'cross-site',
      })))).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(ctx(request('PATCH'))))
        .rejects.toThrow(ForbiddenException);
      const csrf=await webSessionCsrfToken(request(),lookup,policy);
      const mutate=request('PATCH',{
        origin:policy.origin,'x-folio-csrf':csrf,
      });
      await expect(guard.canActivate(ctx(mutate))).resolves.toBe(true);
      expect(mutate.auth).toEqual(identity);
      await expect(guard.canActivate(ctx(request('DELETE',{
        origin:policy.origin,'x-folio-csrf':'X'.repeat(43),
      })))).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(ctx(request('GET',{
        authorization:'Bearer '+raw,
      })))).rejects.toThrow(UnauthorizedException);
      const insecure=request();
      insecure.socket.encrypted=false;
      await expect(guard.canActivate(ctx(insecure))).rejects
        .toThrow(ServiceUnavailableException);
      await expect(new VerifiedSelfSessionGuard(async()=>null)
        .canActivate(ctx(request()))).rejects.toThrow(UnauthorizedException);
      await expect(new VerifiedSelfSessionGuard(async()=>{
        throw Error('test DB offline');
      }).canActivate(ctx(request()))).rejects.toThrow(ServiceUnavailableException);
    }finally{
      for(const [name,value] of Object.entries(original)){
        if(value===undefined)delete process.env[name];
        else process.env[name]=value;
      }
    }
  });
});
