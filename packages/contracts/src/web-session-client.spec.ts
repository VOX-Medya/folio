import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  fetchWebSessionCsrf,loginWebSession,logoutWebSession,WebSessionHttpError,
} from './web-session-client.js';

const origin='https://reader.folio.example';
const password='Valid-Password-From-User-2026!';
const requestId='11111111-2222-4333-8444-555555555555';
const csrf='A'.repeat(43);
const options=(fetcher:typeof fetch)=>({baseUrl:origin,fetcher});

function browser(){
  vi.stubGlobal('window',{location:{origin}});
  vi.stubGlobal('document',{});
}
afterEach(()=>vi.unstubAllGlobals());

describe('strict browser-only HttpOnly web session client',()=>{
  it('fails closed on native/SSR, cross-origin, insecure or malformed API before network',async()=>{
    let calls=0;
    const never:typeof fetch=async()=>{calls++;throw new Error('Unexpected network');};
    await expect(loginWebSession(options(never),{email:'user@example.com',password}))
      .rejects.toThrow(/browser HTTPS/);
    browser();
    for(const baseUrl of [
      'http://reader.folio.example','https://other.folio.example',
      'https://user:pass@reader.folio.example',
      origin+'/v1','https://reader.folio.example?x=1',
    ]){
      await expect(fetchWebSessionCsrf({...options(never),baseUrl})).rejects.toThrow();
    }
    await expect(loginWebSession(options(never),{
      email:'user@example.com',password,userId:'forged',
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('posts validated credentials using same-origin browser cookies, never Authorization',async()=>{
    browser();
    let calls=0;
    const mock:typeof fetch=async(url,init)=>{
      calls++;
      expect(String(url)).toBe(origin+'/v1/auth/web/login');
      expect(init?.method).toBe('POST');
      expect(init?.mode).toBe('same-origin');
      expect(init?.credentials).toBe('same-origin');
      expect(init?.cache).toBe('no-store');
      expect(init?.redirect).toBe('error');
      expect(init?.referrerPolicy).toBe('no-referrer');
      expect(init?.headers).toEqual({accept:'application/json',
        'content-type':'application/json'});
      expect(JSON.parse(String(init?.body))).toEqual({
        email:'reader@example.com',password,
      });
      return new Response(null,{status:204});
    };
    await expect(loginWebSession(options(mock),{
      email:'  reader@example.com  ',password,
    })).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('preserves generic status/request ID and never echoes password in errors',async()=>{
    browser();
    const mock:typeof fetch=async()=>new Response(JSON.stringify({
      error:{code:'UNAUTHORIZED',message:'Invalid email or password',requestId},
    }),{status:401});
    try{
      await loginWebSession(options(mock),{email:'user@example.com',password});
      throw new Error('Missing expected login failure');
    }catch(error){
      expect(error).toBeInstanceOf(WebSessionHttpError);
      const failure=error as WebSessionHttpError;
      expect({status:failure.status,code:failure.code,requestId:failure.requestId})
        .toEqual({status:401,code:'UNAUTHORIZED',requestId});
      expect(failure.message).not.toContain(password);
      expect(failure.message).not.toContain('user@example.com');
    }
  });

  it('validates 204-only CSRF bootstrap without reading any cookie',async()=>{
    browser();
    const mock:typeof fetch=async(url,init)=>{
      expect(String(url)).toBe(origin+'/v1/auth/web/csrf');
      expect(init?.method).toBe('GET');
      expect(init?.credentials).toBe('same-origin');
      expect(init?.headers).toEqual({accept:'application/json'});
      return new Response(null,{status:204,headers:{'x-folio-csrf':csrf}});
    };
    expect(await fetchWebSessionCsrf(options(mock))).toBe(csrf);
    for(const returned of [
      new Response(null,{status:204}),
      new Response(null,{status:204,headers:{'x-folio-csrf':'bad'}}),
      new Response(JSON.stringify({csrf}),{status:200}),
    ]){
      await expect(fetchWebSessionCsrf(options(async()=>returned)))
        .rejects.toBeInstanceOf(WebSessionHttpError);
    }
  });

  it('gets CSRF and revokes exactly the current server session with no client token storage',async()=>{
    browser();
    const urls:string[]=[];
    const mock:typeof fetch=async(url,init)=>{
      urls.push(String(url));
      expect(init?.credentials).toBe('same-origin');
      if(urls.length===1){
        expect(init?.method).toBe('GET');
        return new Response(null,{status:204,headers:{'x-folio-csrf':csrf}});
      }
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toEqual({accept:'application/json','x-folio-csrf':csrf});
      return new Response(null,{status:204});
    };
    await expect(logoutWebSession(options(mock))).resolves.toBeUndefined();
    expect(urls).toEqual([
      origin+'/v1/auth/web/csrf',
      origin+'/v1/auth/web/logout',
    ]);
  });

  it('never attempts logout when CSRF is missing or the session has expired',async()=>{
    browser();
    let calls=0;
    const mock:typeof fetch=async()=>{
      calls++;
      return new Response(JSON.stringify({
        error:{code:'UNAUTHORIZED',message:'Expired',requestId},
      }),{status:401});
    };
    await expect(logoutWebSession(options(mock))).rejects.toMatchObject({
      status:401,code:'UNAUTHORIZED',requestId,
    });
    expect(calls).toBe(1);
  });
});
