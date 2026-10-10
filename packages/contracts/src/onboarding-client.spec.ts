import {describe,expect,it} from 'vitest';
import {
  fetchOwnOnboarding,updateOwnOnboarding,
  OnboardingHttpError,OnboardingVersionConflictError,
} from './onboarding-client.js';

const session='A'.repeat(43);
const baseUrl='https://folio.example';
const userId='11111111-2222-4333-8444-555555555555';
const snapshot={userId,stage:'language',locale:'en',interests:[],version:1};
const requestId='99999999-aaaa-4bbb-8ccc-dddddddddddd';
const options=(fetcher:typeof fetch)=>({baseUrl,bearerToken:session,fetcher});

describe('stateless verified-user onboarding client',()=>{
  it('sends only bearer identity, never cookies/query/user IDs for GET',async()=>{
    const captures:Array<{url:string,init:RequestInit|undefined}>=[];
    const mock:typeof fetch=async (target,init)=>{
      captures.push({url:String(target),init});
      return new Response(JSON.stringify(snapshot),{
        status:200,headers:{'content-type':'application/json'},
      });
    };
    expect(await fetchOwnOnboarding(options(mock))).toEqual(snapshot);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe(baseUrl+'/v1/me/onboarding');
    expect(captures[0]?.init?.credentials).toBe('omit');
    expect(captures[0]?.init?.cache).toBe('no-store');
    expect(captures[0]?.init?.redirect).toBe('error');
    expect(captures[0]?.init?.headers).toEqual({
      authorization:'Bearer '+session,accept:'application/json',
    });
    expect(captures[0]?.init?.body).toBeUndefined();
  });
  it('sends validated optimistic PATCH with no owner override',async()=>{
    let sentBody:unknown;
    const mock:typeof fetch=async (_target,init)=>{
      sentBody=JSON.parse(String(init?.body));
      expect(init?.method).toBe('PATCH');
      expect(init?.headers).toEqual({
        authorization:'Bearer '+session,accept:'application/json',
        'content-type':'application/json',
      });
      return new Response(JSON.stringify(snapshot),{status:200});
    };
    expect(await updateOwnOnboarding(options(mock),{
      expectedVersion:0,stage:'language',locale:'en',interests:[],
    })).toEqual(snapshot);
    expect(sentBody).toEqual({expectedVersion:0,stage:'language',locale:'en',interests:[]});
    let networkCalls=0;
    const never:typeof fetch=async()=>{networkCalls++;throw new Error('Unexpected network');};
    await expect(updateOwnOnboarding(options(never),{
      expectedVersion:0,stage:'language',locale:'en',interests:[],
      userId,
    })).rejects.toThrow();
    await expect(updateOwnOnboarding(options(never),{
      expectedVersion:0,stage:'complete',locale:'en',interests:['x','x'],
    })).rejects.toThrow();
    expect(networkCalls).toBe(0);
  });
  it('rejects missing token and insecure transport before network',async()=>{
    let calls=0;
    const never:typeof fetch=async()=>{calls++;throw new Error('Unexpected network');};
    await expect(fetchOwnOnboarding({...options(never),bearerToken:'spoofed'})).rejects.toThrow();
    await expect(fetchOwnOnboarding({...options(never),baseUrl:'http://reader.example'})).rejects.toThrow();
    await expect(fetchOwnOnboarding({...options(never),baseUrl:'https://user:password@folio.example'})).rejects.toThrow();
    await expect(fetchOwnOnboarding({...options(never),baseUrl:'https://folio.example/prefix'})).rejects.toThrow();
    expect(calls).toBe(0);
    // Direct local Folio-only development is allowed; non-loopback HTTP is not.
    const local:typeof fetch=async (target)=>{
      expect(String(target)).toBe('http://127.0.0.1:3310/v1/me/onboarding');
      return new Response(JSON.stringify(snapshot),{status:200});
    };
    expect(await fetchOwnOnboarding({
      ...options(local),baseUrl:'http://127.0.0.1:3310',
    })).toEqual(snapshot);
  });
  it('preserves 409 conflict semantics and request IDs, no secret in thrown errors',async()=>{
    const mock:typeof fetch=async()=>new Response(JSON.stringify({
      error:{code:'CONFLICT',message:'Reload current state',requestId},
    }),{status:409,headers:{'content-type':'application/json'}});
    try{
      await updateOwnOnboarding(options(mock),{
        expectedVersion:0,stage:'language',locale:'en',interests:[],
      });
      throw new Error('Missing expected conflict');
    }catch(error){
      expect(error).toBeInstanceOf(OnboardingVersionConflictError);
      const conflict=error as OnboardingVersionConflictError;
      expect(conflict.status).toBe(409);
      expect(conflict.requestId).toBe(requestId);
      expect(conflict.message).not.toContain(session);
    }
  });
  it('fails explicitly on revoked auth, unavailable API and malformed response',async()=>{
    for(const [status,code] of [[401,'UNAUTHORIZED'],[503,'SERVICE_UNAVAILABLE']] as const){
      const mock:typeof fetch=async()=>new Response(JSON.stringify({
        error:{code,message:'Unavailable',requestId},
      }),{status});
      await expect(fetchOwnOnboarding(options(mock))).rejects.toMatchObject({
        status,code,requestId,
      });
    }
    const failure:typeof fetch=async()=>new Response('not-json',{status:500});
    await expect(fetchOwnOnboarding(options(failure))).rejects.toBeInstanceOf(OnboardingHttpError);
    const invalidSuccess:typeof fetch=async()=>new Response(JSON.stringify({
      ...snapshot,userId:'somebody',
    }),{status:200});
    await expect(fetchOwnOnboarding(options(invalidSuccess))).rejects.toThrow();
  });
});
