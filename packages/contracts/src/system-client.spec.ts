import {describe,expect,it} from 'vitest';
import {
  fetchCapabilities,fetchSystemHealth,fetchSystemReadiness,SystemHttpError,
  encodeCursor,
} from './index.js';

const origin='https://api.folio.example';
const requestId='11111111-2222-4333-8444-555555555555';
const healthy={status:'ok'};
const ready={status:'ready'};
const page={items:[{id:'rsvp',available:false,note:'Not deployed'}],nextCursor:null};
const error=(status:number,code:string)=>
  new Response(JSON.stringify({error:{code,message:'Internal error should not be echoed',requestId}}),
    {status,headers:{'x-request-id':requestId}});

describe('shared system API transport for Web, native and admin',()=>{
  it('uses credential-free/no-store redirect-denied GET for all public status routes',async()=>{
    const seen:string[]=[];
    const fetcher:typeof fetch=async(url,init)=>{
      seen.push(String(url));
      expect(init).toMatchObject({
        method:'GET',credentials:'omit',cache:'no-store',redirect:'error',
        referrerPolicy:'no-referrer',headers:{accept:'application/json'},
      });
      expect(init?.body).toBeUndefined();
      const result=String(url).endsWith('/health')?healthy
        :String(url).endsWith('/ready')?ready:page;
      return new Response(JSON.stringify(result),{status:200});
    };
    await expect(fetchSystemHealth(origin,fetcher)).resolves.toEqual(healthy);
    await expect(fetchSystemReadiness(origin,fetcher)).resolves.toEqual(ready);
    await expect(fetchCapabilities(origin,{},fetcher)).resolves.toEqual(page);
    expect(seen).toEqual([
      origin+'/v1/health',origin+'/v1/ready',
      origin+'/v1/system/capabilities',
    ]);
  });

  it('allows explicit local loopback HTTP but rejects external cleartext and injected origins before fetch',async()=>{
    let calls=0;
    const never:typeof fetch=async()=>{calls++;throw new Error('Network must not be touched');};
    for(const bad of [
      'http://example.com','http://0.0.0.0:3100',
      'ftp://api.folio.example','https://name:pass@api.folio.example',
      origin+'/other','https://api.folio.example?scope=private',
      origin+'#fragment','not a URL',
    ]){
      await expect(fetchSystemHealth(bad,never)).rejects.toThrow();
      await expect(fetchSystemReadiness(bad,never)).rejects.toThrow();
    }
    expect(calls).toBe(0);
    await expect(fetchSystemHealth('http://127.0.0.1:3100/',async()=>
      new Response(JSON.stringify(healthy),{status:200}))).resolves.toEqual(healthy);
  });

  it('validates limit/cursor/extra fields before network, encodes only canonical query parameters',async()=>{
    let calls=0;
    const fetcher:typeof fetch=async(url)=>{
      calls++;
      expect(String(url)).toBe(
        origin+'/v1/system/capabilities?limit=2&cursor='+encodeURIComponent(encodeCursor('rsvp')),
      );
      return new Response(JSON.stringify(page),{status:200});
    };
    for(const query of [
      {limit:0},{limit:51},{limit:-1},{limit:1.5},{limit:NaN},
      {limit:1,userId:'fake'},{cursor:'%2F%2F'},{cursor:'A'.repeat(181)},
    ]){
      await expect(fetchCapabilities(origin,query as {limit?:number;cursor?:string},fetcher))
        .rejects.toThrow('Invalid pagination parameters');
    }
    expect(calls).toBe(0);
    await expect(fetchCapabilities(origin,{limit:2,cursor:encodeCursor('rsvp')},fetcher))
      .resolves.toEqual(page);
    expect(calls).toBe(1);
  });

  it('preserves typed service status, code and correlation ID but never echoes server error text',async()=>{
    const fetcher:typeof fetch=async()=>error(503,'SERVICE_UNAVAILABLE');
    await expect(fetchSystemReadiness(origin,fetcher)).rejects.toMatchObject({
      name:'SystemHttpError',status:503,code:'SERVICE_UNAVAILABLE',requestId,
    });
    try{await fetchSystemReadiness(origin,fetcher);}
    catch(cause){
      expect(cause).toBeInstanceOf(SystemHttpError);
      expect(String(cause)).not.toContain('Internal error should not be echoed');
    }
    await expect(fetchCapabilities(origin,{},async()=>error(400,'BAD_REQUEST')))
      .rejects.toMatchObject({status:400,code:'BAD_REQUEST',requestId});
  });

  it('fails closed on malformed error JSON, missing request ID and unexpected success status',async()=>{
    for(const response of [
      new Response('not json',{status:503}),
      new Response(JSON.stringify({error:{code:'FORBIDDEN'}}),{status:403}),
    ]){
      await expect(fetchSystemReadiness(origin,async()=>response))
        .rejects.toMatchObject({code:'UNEXPECTED_HTTP_RESPONSE',requestId:null});
    }
    await expect(fetchSystemHealth(origin,async()=>new Response(null,{status:204})))
      .rejects.toMatchObject({status:204,code:'UNEXPECTED_HTTP_RESPONSE'});
  });

  it('requires exact health/readiness/page DTO, never accepts fabricated success',async()=>{
    for(const [action,invalid] of [
      [fetchSystemHealth,{status:'ready'}],
      [fetchSystemHealth,{status:'ok',accountId:'not-public'}],
      [fetchSystemReadiness,{status:'ok'}],
      [fetchSystemReadiness,{status:'ready',queueJobs:999}],
      [(url:string,fetcher:typeof fetch)=>fetchCapabilities(url,{},fetcher),
        {items:[{...page.items[0],email:'leak@example.com'}],nextCursor:null}],
    ] as const){
      await expect(action(origin,async()=>new Response(JSON.stringify(invalid),{status:200})))
        .rejects.toMatchObject({status:200,code:'INVALID_SYSTEM_RESPONSE'});
    }
    await expect(fetchSystemHealth(origin,async()=>new Response('not json',{status:200})))
      .rejects.toMatchObject({code:'INVALID_SYSTEM_RESPONSE'});
  });
});
