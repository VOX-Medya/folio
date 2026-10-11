import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchOwnWebProfile,updateOwnWebProfile,requestOwnWebDeletion} from './own-profile-client.js';
import {WebSessionHttpError} from './web-session-client.js';

const base='https://folio.example',userId='11111111-1111-4111-8111-111111111111';
const profile={userId,displayName:'',locale:'tr',visibility:'private',
  deletionRequestedAt:null,version:0};
function web(){vi.stubGlobal('window',{location:{origin:base}});vi.stubGlobal('document',{});}
afterEach(()=>vi.unstubAllGlobals());
describe('private owner profile browser transport',()=>{
  it('accepts only exact-origin HTTPS and strict private snapshot',async()=>{
    web();
    const fetcher=vi.fn(async()=>new Response(JSON.stringify(profile),{status:200})) as unknown as typeof fetch;
    expect((await fetchOwnWebProfile(base,{fetcher})).visibility).toBe('private');
    expect(vi.mocked(fetcher).mock.calls[0]?.[1]).toMatchObject({
      method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',
    });
    await expect(fetchOwnWebProfile('http://folio.example',{fetcher})).rejects.toThrow();
    const forged=vi.fn(async()=>new Response(JSON.stringify({...profile,email:'private@example.com'}),
      {status:200})) as unknown as typeof fetch;
    await expect(fetchOwnWebProfile(base,{fetcher:forged})).rejects.toThrow(WebSessionHttpError);
  });
  it('writes optimistic version with cookie + CSRF, no supplied principal',async()=>{
    web();
    const calls:string[]=[];
    const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      calls.push(String(url));
      if(String(url).endsWith('/csrf'))return new Response(null,{status:204,
        headers:{'x-folio-csrf':'A'.repeat(43)}});
      expect(init).toMatchObject({
        method:'PATCH',credentials:'same-origin',headers:{'x-folio-csrf':'A'.repeat(43)},
      });
      expect(init?.body).toBe(JSON.stringify({
        expectedVersion:0,displayName:'Reader',locale:'en',visibility:'private',
      }));
      return new Response(JSON.stringify({...profile,version:1,displayName:'Reader',locale:'en'}),
        {status:200});
    }) as unknown as typeof fetch;
    const update={expectedVersion:0,displayName:'Reader',locale:'en',visibility:'private'};
    expect((await updateOwnWebProfile(base,update,{fetcher})).version).toBe(1);
    expect(calls).toHaveLength(2);
    await expect(updateOwnWebProfile(base,{...update,userId},{fetcher})).rejects.toThrow();
    const conflict=vi.fn(async(url:RequestInfo|URL)=>{
      if(String(url).endsWith('/csrf'))return new Response(null,{status:204,
        headers:{'x-folio-csrf':'A'.repeat(43)}});
      return new Response(null,{status:409});
    }) as unknown as typeof fetch;
    await expect(updateOwnWebProfile(base,update,{fetcher:conflict}))
      .rejects.toMatchObject({status:409});
  });
  it('requires explicit confirmation before requesting deletion',async()=>{
    web();
    const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      if(String(url).endsWith('/csrf'))return new Response(null,{status:204,
        headers:{'x-folio-csrf':'A'.repeat(43)}});
      expect(init?.body).toBe(JSON.stringify({confirm:true}));
      return new Response(JSON.stringify({requested:true}),{status:200});
    }) as unknown as typeof fetch;
    await expect(requestOwnWebDeletion(base,{confirm:false},{fetcher})).rejects.toThrow();
    expect((await requestOwnWebDeletion(base,{confirm:true},{fetcher})).requested).toBe(true);
  });
});
