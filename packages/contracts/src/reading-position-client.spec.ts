import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchOwnWebReadingPosition,saveOwnWebReadingPosition} from './reading-position-client.js';
import {WebSessionHttpError} from './web-session-client.js';

const revisionId='33333333-3333-4333-8333-333333333333';
const chapterId='44444444-4444-4444-8444-444444444444';
const blockId='55555555-5555-4555-8555-555555555555';
const pointer={revisionId,chapterId,blockId,tokenOffset:0,audioPositionMs:null,
  mode:'normal' as const,version:1};
afterEach(()=>vi.unstubAllGlobals());

function web(){vi.stubGlobal('window',{location:{origin:'https://folio.example'}});vi.stubGlobal('document',{});}
describe('owner-only position web transport',()=>{
  it('reads only same-origin HTTPS cookie with strict response',async()=>{
    web();
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({progress:pointer}),{status:200})) as unknown as typeof fetch;
    expect((await fetchOwnWebReadingPosition('https://folio.example',revisionId,{fetcher}))
      .progress?.version).toBe(1);
    expect(vi.mocked(fetcher).mock.calls[0]?.[1]).toMatchObject({
      method:'GET',credentials:'same-origin',redirect:'error',
    });
    await expect(fetchOwnWebReadingPosition('http://folio.example',revisionId,{fetcher}))
      .rejects.toThrow();
    const leak=vi.fn(async()=>new Response(JSON.stringify({
      progress:{...pointer,userId:'secret'},
    }),{status:200})) as unknown as typeof fetch;
    await expect(fetchOwnWebReadingPosition('https://folio.example',revisionId,{fetcher:leak}))
      .rejects.toThrow();
  });
  it('requires session CSRF for a CAS write, sends no identity, and passes through 409',async()=>{
    web();
    const calls:string[]=[];
    const fetcher=vi.fn(async (url:RequestInfo|URL,request?:RequestInit)=>{
      calls.push(String(url));
      if(String(url).endsWith('/csrf'))return new Response(null,{
        status:204,headers:{'x-folio-csrf':'A'.repeat(43)},
      });
      expect(request).toMatchObject({
        method:'PUT',credentials:'same-origin',headers:{'x-folio-csrf':'A'.repeat(43)},
      });
      expect(request?.body).toBe(JSON.stringify({
        expectedVersion:0,chapterId,blockId,tokenOffset:0,audioPositionMs:null,mode:'normal',
      }));
      return new Response(JSON.stringify({progress:pointer}),{status:200});
    }) as unknown as typeof fetch;
    const update={expectedVersion:0,chapterId,blockId,tokenOffset:0,
      audioPositionMs:null,mode:'normal'};
    expect((await saveOwnWebReadingPosition('https://folio.example',revisionId,update,{fetcher}))
      .progress?.version).toBe(1);
    expect(calls).toHaveLength(2);
    const stale=vi.fn(async(url:RequestInfo|URL)=>{
      if(String(url).endsWith('/csrf'))return new Response(null,{
        status:204,headers:{'x-folio-csrf':'A'.repeat(43)},
      });
      return new Response(null,{status:409});
    }) as unknown as typeof fetch;
    await expect(saveOwnWebReadingPosition('https://folio.example',revisionId,update,{fetcher:stale}))
      .rejects.toMatchObject({status:409} satisfies Partial<WebSessionHttpError>);
    await expect(saveOwnWebReadingPosition('https://folio.example',revisionId,
      {...update,userId:'unauthorized'},{fetcher})).rejects.toThrow();
  });
});
