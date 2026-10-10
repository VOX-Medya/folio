import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  fetchWebDeviceSessions,revokeWebDeviceSession,WebSessionHttpError,
} from './web-session-client.js';

const origin='https://reader.folio.example';
const id='11111111-2222-4333-8444-555555555555';
const csrf='A'.repeat(43);
const requestId='22222222-3333-4333-8444-666666666666';
const item={id,deviceLabel:'web',createdAt:'2026-10-10T08:00:00.000Z',
  expiresAt:'2026-11-09T08:00:00.000Z',isCurrent:true};

function browser(){
  vi.stubGlobal('window',{location:{origin}});
  vi.stubGlobal('document',{});
}
const options=(fetcher:typeof fetch)=>({baseUrl:origin,fetcher});
afterEach(()=>vi.unstubAllGlobals());

describe('HttpOnly browser device session management',()=>{
  it('never sends cookie credentials from native, HTTP or another origin',async()=>{
    let calls=0;
    const never:typeof fetch=async()=>{calls++;throw new Error('Unexpected network');};
    await expect(fetchWebDeviceSessions(options(never))).rejects.toThrow(/browser HTTPS/);
    browser();
    for(const bad of ['http://reader.folio.example','https://wrong.example',
      origin+'/unsafe','https://name:password@reader.folio.example']){
      await expect(fetchWebDeviceSessions({...options(never),baseUrl:bad}))
        .rejects.toThrow();
    }
    await expect(revokeWebDeviceSession(options(never),'../../another-account'))
      .rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('reads strictly owner-scoped devices with same-origin/no-store and no Authorization',async()=>{
    browser();
    const fetcher:typeof fetch=async(url,init)=>{
      expect(String(url)).toBe(origin+'/v1/me/sessions');
      expect(init).toMatchObject({method:'GET',mode:'same-origin',
        credentials:'same-origin',cache:'no-store',redirect:'error',
        referrerPolicy:'no-referrer'});
      expect(init?.headers).toEqual({accept:'application/json'});
      return new Response(JSON.stringify({items:[item]}),{status:200});
    };
    await expect(fetchWebDeviceSessions(options(fetcher))).resolves
      .toEqual({items:[item]});
  });

  it('rejects malformed or expanded inventory instead of exposing extraneous account data',async()=>{
    browser();
    for(const data of [
      {items:[{...item,sessionToken:'should-not-appear'}]},
      {items:[{...item,deviceLabel:'',isCurrent:'yes'}]},
      {items:[item],email:'reader@example.com'},
      {items:'malformed'},
    ]){
      await expect(fetchWebDeviceSessions(options(async()=>
        new Response(JSON.stringify(data),{status:200}))))
        .rejects.toMatchObject({code:'INVALID_SESSION_RESPONSE'});
    }
    await expect(fetchWebDeviceSessions(options(async()=>
      new Response('not-json',{status:200}))))
      .rejects.toMatchObject({code:'INVALID_SESSION_RESPONSE'});
    await expect(fetchWebDeviceSessions(options(async()=>
      new Response(null,{status:204}))))
      .rejects.toMatchObject({code:'UNEXPECTED_HTTP_RESPONSE'});
  });

  it('requires fresh server CSRF before deleting exactly one validated device',async()=>{
    browser();
    const calls:string[]=[];
    const fetcher:typeof fetch=async(url,init)=>{
      calls.push(String(url));
      expect(init?.credentials).toBe('same-origin');
      expect(init?.cache).toBe('no-store');
      expect(init?.redirect).toBe('error');
      if(calls.length===1){
        expect(init?.method).toBe('GET');
        expect(init?.headers).toEqual({accept:'application/json'});
        return new Response(null,{status:204,headers:{'x-folio-csrf':csrf}});
      }
      expect(init?.method).toBe('DELETE');
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toEqual({accept:'application/json','x-folio-csrf':csrf});
      return new Response(null,{status:204});
    };
    await expect(revokeWebDeviceSession(options(fetcher),id)).resolves.toBeUndefined();
    expect(calls).toEqual([
      origin+'/v1/auth/web/csrf',
      origin+'/v1/me/sessions/'+id,
    ]);
  });

  it('prevents DELETE on missing CSRF or revoked cookie and preserves generic HTTP errors',async()=>{
    browser();
    let calls=0;
    const noCsrf:typeof fetch=async()=>{
      calls++;
      return new Response(null,{status:204});
    };
    await expect(revokeWebDeviceSession(options(noCsrf),id))
      .rejects.toMatchObject({code:'INVALID_CSRF_RESPONSE'});
    expect(calls).toBe(1);

    const revoked:typeof fetch=async()=>{
      calls++;
      return new Response(JSON.stringify({
        error:{code:'UNAUTHORIZED',message:'Expired session',requestId},
      }),{status:401});
    };
    await expect(revokeWebDeviceSession(options(revoked),id))
      .rejects.toMatchObject({status:401,code:'UNAUTHORIZED',requestId});
    expect(calls).toBe(2);
    await expect(fetchWebDeviceSessions(options(revoked)))
      .rejects.toBeInstanceOf(WebSessionHttpError);
  });

  it('rejects success-shaped non-204 DELETE and handles a foreign-device 404 safely',async()=>{
    browser();
    let count=0;
    const fetcher:typeof fetch=async()=>{
      count++;
      return count===1
        ?new Response(null,{status:204,headers:{'x-folio-csrf':csrf}})
        :new Response(null,{status:200});
    };
    await expect(revokeWebDeviceSession(options(fetcher),id))
      .rejects.toMatchObject({code:'UNEXPECTED_HTTP_RESPONSE'});
    const denied:typeof fetch=async(url)=>{
      if(String(url).endsWith('/csrf')){
        return new Response(null,{status:204,headers:{'x-folio-csrf':csrf}});
      }
      return new Response(JSON.stringify({
        error:{code:'NOT_FOUND',message:'Session not found',requestId},
      }),{status:404});
    };
    await expect(revokeWebDeviceSession(options(denied),id))
      .rejects.toMatchObject({status:404,code:'NOT_FOUND',requestId});
  });
});
