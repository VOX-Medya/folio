import {describe,expect,it} from 'vitest';
import {fetchOwnDeviceSessions,revokeOwnDeviceSession,DeviceSessionHttpError} from './device-sessions-client.js';

const baseUrl='https://folio.example',session='B'.repeat(43);
const id='7e38fd6a-1214-4fdd-89ee-92c0cb8a10ba';
const other='14af3154-1e9c-4a1d-b78c-89a0e8263cb6';
const requestId='99999999-aaaa-4bbb-8ccc-dddddddddddd';
const inventory={items:[
  {id,deviceLabel:'web',isCurrent:true,
    createdAt:'2026-10-10T07:00:00.000Z',expiresAt:'2026-11-09T07:00:00.000Z'},
  {id:other,deviceLabel:'android',isCurrent:false,
    createdAt:'2026-10-10T07:20:00.000Z',expiresAt:'2026-11-09T07:20:00.000Z'},
]};
const options=(fetcher:typeof fetch)=>({baseUrl,bearerToken:session,fetcher});

describe('stateless verified-account device session client',()=>{
  it('GET sends only verified bearer and cannot select an account',async()=>{
    let called=0;
    const controller=new AbortController();
    const fetcher:typeof fetch=async (target,init)=>{
      called++;
      expect(String(target)).toBe(baseUrl+'/v1/me/sessions');
      expect(init).toMatchObject({method:'GET',credentials:'omit',cache:'no-store',redirect:'error'});
      expect(init?.headers).toEqual({authorization:'Bearer '+session,accept:'application/json'});
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBe(controller.signal);
      return new Response(JSON.stringify(inventory),{status:200});
    };
    expect(await fetchOwnDeviceSessions({...options(fetcher),signal:controller.signal}))
      .toEqual(inventory);
    expect(called).toBe(1);
  });
  it('DELETE uses validated UUID and accepts only 204 no-content',async()=>{
    let calls=0;
    const fetcher:typeof fetch=async (target,init)=>{
      calls++;
      expect(String(target)).toBe(baseUrl+'/v1/me/sessions/'+other);
      expect(init).toMatchObject({method:'DELETE',credentials:'omit',cache:'no-store',redirect:'error'});
      expect(init?.headers).toEqual({authorization:'Bearer '+session,accept:'application/json'});
      expect(init?.body).toBeUndefined();
      return new Response(null,{status:204});
    };
    expect(await revokeOwnDeviceSession(options(fetcher),other)).toBeUndefined();
    expect(calls).toBe(1);
    for(const bad of ['another-user','../v1/admin','abc?userId=1','','null',null]){
      await expect(revokeOwnDeviceSession(options(fetcher),bad)).rejects.toThrow();
    }
    expect(calls).toBe(1);
  });
  it('never silently accepts unexpected HTTP 200 on a DELETE',async()=>{
    const fetcher:typeof fetch=async()=>new Response('{}',{status:200});
    await expect(revokeOwnDeviceSession(options(fetcher),id)).rejects.toMatchObject({
      status:200,code:'UNEXPECTED_HTTP_RESPONSE',requestId:null,
    });
  });
  it('preserves server-issued error codes and IDs without leaking the token',async()=>{
    for(const [status,code] of [[401,'UNAUTHORIZED'],[404,'NOT_FOUND'],[503,'SERVICE_UNAVAILABLE']] as const){
      const fetcher:typeof fetch=async()=>new Response(JSON.stringify({
        error:{code,message:'Request failed',requestId},
      }),{status});
      try{
        await revokeOwnDeviceSession(options(fetcher),id);
        throw new Error('HTTP failure was not detected');
      }catch(error){
        expect(error).toBeInstanceOf(DeviceSessionHttpError);
        const failure=error as DeviceSessionHttpError;
        expect(failure.status).toBe(status);
        expect(failure.code).toBe(code);
        expect(failure.requestId).toBe(requestId);
        expect(failure.message).not.toContain(session);
        expect(failure.message).not.toContain(id);
      }
    }
  });
  it('rejects insecure origins and bearer errors before calling the network',async()=>{
    let calls=0;
    const never:typeof fetch=async()=>{calls++;throw new Error('network must not execute');};
    for(const url of ['http://folio.example','https://user:pass@folio.example',
      'https://folio.example/sessions','https://folio.example?userId=1',
      'http://localhost.attacker.com']){
      await expect(fetchOwnDeviceSessions({...options(never),baseUrl:url})).rejects.toThrow();
    }
    await expect(fetchOwnDeviceSessions({...options(never),bearerToken:'unverified'}))
      .rejects.toThrow();
    expect(calls).toBe(0);
    const local:typeof fetch=async (target)=>{
      expect(String(target)).toBe('http://127.0.0.1:3100/v1/me/sessions');
      return new Response(JSON.stringify(inventory),{status:200});
    };
    expect(await fetchOwnDeviceSessions({...options(local),baseUrl:'http://127.0.0.1:3100'}))
      .toEqual(inventory);
  });
  it('rejects sensitive/foreign fields and non-JSON successful responses',async()=>{
    const leaked:typeof fetch=async()=>new Response(JSON.stringify({
      items:[{...inventory.items[0],tokenDigest:'a'.repeat(64)}],
    }),{status:200});
    await expect(fetchOwnDeviceSessions(options(leaked))).rejects.toThrow();
    const wrong:typeof fetch=async()=>new Response('not JSON',{status:200});
    await expect(fetchOwnDeviceSessions(options(wrong))).rejects.toThrow();
    const malformedError:typeof fetch=async()=>new Response('not JSON',{status:500});
    await expect(fetchOwnDeviceSessions(options(malformedError))).rejects.toMatchObject({
      status:500,code:'UNEXPECTED_HTTP_RESPONSE',requestId:null,
    });
  });
});
