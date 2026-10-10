import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  fetchWebOnboarding,updateWebOnboarding,WebSessionHttpError,
} from './web-session-client.js';

const origin='https://reader.folio.example';
const userId='11111111-2222-4333-8444-555555555555';
const requestId='22222222-3333-4333-8444-666666666666';
const csrf='A'.repeat(43);
const welcome={userId,stage:'welcome',locale:'tr',interests:[],version:0};
const options=(fetcher:typeof fetch)=>({baseUrl:origin,fetcher});
function browser(){
  vi.stubGlobal('window',{location:{origin}});
  vi.stubGlobal('document',{});
}
const errorResponse=(status:number,code:string)=>
  new Response(JSON.stringify({error:{code,message:'Generic error',requestId}}),{status});
afterEach(()=>vi.unstubAllGlobals());

describe('strict same-origin HttpOnly web onboarding transport',()=>{
  it('denies native, HTTP, cross-origin and caller-selected ownership before network',async()=>{
    let calls=0;
    const never:typeof fetch=async()=>{calls++;throw Error('Network must remain closed');};
    await expect(fetchWebOnboarding(options(never))).rejects.toThrow(/browser HTTPS/);
    browser();
    for(const bad of ['http://reader.folio.example','https://different.example',
      origin+'/v1/me','https://bad:pass@reader.folio.example']){
      await expect(fetchWebOnboarding({...options(never),baseUrl:bad})).rejects.toThrow();
    }
    await expect(updateWebOnboarding(options(never),{
      expectedVersion:0,stage:'language',locale:'tr',interests:[],userId,
    })).rejects.toThrow();
    await expect(updateWebOnboarding(options(never),{
      expectedVersion:-1,stage:'language',locale:'tr',interests:[],
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('loads the owner snapshot only over secure same-origin no-store without bearer',async()=>{
    browser();
    const fetcher:typeof fetch=async(url,init)=>{
      expect(String(url)).toBe(origin+'/v1/me/onboarding');
      expect(init).toMatchObject({
        method:'GET',mode:'same-origin',credentials:'same-origin',
        cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
      });
      expect(init?.headers).toEqual({accept:'application/json'});
      return new Response(JSON.stringify(welcome),{status:200});
    };
    await expect(fetchWebOnboarding(options(fetcher))).resolves.toEqual(welcome);
  });

  it('fails closed on schema expansion, malformed JSON and non-200 success',async()=>{
    browser();
    for(const raw of [
      {...welcome,sessionToken:'must-not-leak'},
      {...welcome,email:'reader@example.com'},
      {...welcome,version:-1},
      {...welcome,stage:'invented'},
    ]){
      await expect(fetchWebOnboarding(options(async()=>
        new Response(JSON.stringify(raw),{status:200}))))
        .rejects.toMatchObject({code:'INVALID_ONBOARDING_RESPONSE'});
    }
    await expect(fetchWebOnboarding(options(async()=>
      new Response('not json',{status:200}))))
      .rejects.toMatchObject({code:'INVALID_ONBOARDING_RESPONSE'});
    await expect(fetchWebOnboarding(options(async()=>
      new Response(null,{status:204}))))
      .rejects.toMatchObject({code:'UNEXPECTED_HTTP_RESPONSE'});
  });

  it('obtains fresh CSRF and persists an optimistic version with no token or userId',async()=>{
    browser();
    const urls:string[]=[];
    const update={expectedVersion:0,stage:'language',locale:'en',interests:[]};
    const saved={...welcome,stage:'language',locale:'en',version:1};
    const fetcher:typeof fetch=async(url,init)=>{
      urls.push(String(url));
      expect(init?.credentials).toBe('same-origin');
      expect(init?.cache).toBe('no-store');
      expect(init?.redirect).toBe('error');
      if(urls.length===1){
        expect(init?.method).toBe('GET');
        expect(init?.headers).toEqual({accept:'application/json'});
        return new Response(null,{status:204,headers:{'x-folio-csrf':csrf}});
      }
      expect(init?.method).toBe('PATCH');
      expect(init?.headers).toEqual({
        accept:'application/json','content-type':'application/json',
        'x-folio-csrf':csrf,
      });
      expect(JSON.parse(String(init?.body))).toEqual(update);
      return new Response(JSON.stringify(saved),{status:200});
    };
    await expect(updateWebOnboarding(options(fetcher),update)).resolves.toEqual(saved);
    expect(urls).toEqual([
      origin+'/v1/auth/web/csrf',
      origin+'/v1/me/onboarding',
    ]);
  });

  it('rejects an invalid CSRF response without ever submitting a PATCH',async()=>{
    browser();
    let calls=0;
    const fetcher:typeof fetch=async()=>{
      calls++;
      return new Response(null,{status:204});
    };
    await expect(updateWebOnboarding(options(fetcher),{
      expectedVersion:0,stage:'language',locale:'tr',interests:[],
    })).rejects.toMatchObject({code:'INVALID_CSRF_RESPONSE'});
    expect(calls).toBe(1);
  });

  it('preserves a 409 conflict and request ID, never retries a stale PATCH',async()=>{
    browser();
    const urls:string[]=[];
    const fetcher:typeof fetch=async(url)=>{
      urls.push(String(url));
      return urls.length===1
        ?new Response(null,{status:204,headers:{'x-folio-csrf':csrf}})
        :errorResponse(409,'CONFLICT');
    };
    await expect(updateWebOnboarding(options(fetcher),{
      expectedVersion:0,stage:'interests',locale:'en',interests:['science'],
    })).rejects.toMatchObject({status:409,code:'CONFLICT',requestId});
    expect(urls).toEqual([
      origin+'/v1/auth/web/csrf',
      origin+'/v1/me/onboarding',
    ]);
  });

  it('on 401 probes once for revoked cookie cleanup and preserves original HTTP error',async()=>{
    browser();
    const urls:string[]=[];
    const fetcher:typeof fetch=async(url)=>{
      urls.push(String(url));
      return urls.length===1
        ?errorResponse(401,'UNAUTHORIZED')
        :errorResponse(503,'SERVICE_UNAVAILABLE');
    };
    await expect(fetchWebOnboarding(options(fetcher)))
      .rejects.toMatchObject({status:401,code:'UNAUTHORIZED',requestId});
    expect(urls).toEqual([
      origin+'/v1/me/onboarding',
      origin+'/v1/auth/web/csrf',
    ]);
    let forbiddenCalls=0;
    await expect(fetchWebOnboarding(options(async()=>{
      forbiddenCalls++;
      return errorResponse(403,'FORBIDDEN');
    }))).rejects.toBeInstanceOf(WebSessionHttpError);
    expect(forbiddenCalls).toBe(1);
  });
});
