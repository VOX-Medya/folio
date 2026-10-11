import {describe,expect,it,vi} from 'vitest';
import {searchPublicCatalog,saveOwnWebShelf,fetchOwnWebShelf} from './public-shelf-client.js';

const id='11111111-1111-4111-8111-111111111111';
const item={id,title:'Synthetic work',authors:['Synthetic author'],
  editionId:'22222222-2222-4222-8222-222222222222',
  revisionId:'33333333-3333-4333-8333-333333333333',audioAvailable:false};
describe('MVP public book search and verified owner shelf requests',()=>{
  it('uses credential-free HTTPS public title search with strict result shape',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({items:[item]}),{status:200}))
      as unknown as typeof fetch;
    const result=await searchPublicCatalog('https://folio.example',{q:'Synthetic',limit:10},{fetcher});
    expect(result.items[0]?.id).toBe(id);
    const args=vi.mocked(fetcher).mock.calls[0]!;
    expect(args[0]).toBe('https://folio.example/v1/catalog/search?q=Synthetic&limit=10');
    expect(args[1]).toMatchObject({credentials:'omit',method:'GET',redirect:'error'});
    await expect(searchPublicCatalog('http://folio.example',{q:'x'},{fetcher})).rejects.toThrow();
    await expect(searchPublicCatalog('https://folio.example',{q:'',userId:id},{fetcher})).rejects.toThrow();
  });
  it('does not accept arbitrary response fields or unauthorized shelf reads',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({items:[{...item,ownerId:id}]}),{status:200}))
      as unknown as typeof fetch;
    await expect(searchPublicCatalog('https://folio.example',{q:'book'},{fetcher}))
      .rejects.toThrow();
    const unauthorized=vi.fn(async()=>new Response('',{status:401})) as unknown as typeof fetch;
    await expect(fetchOwnWebShelf('https://folio.example',{fetcher:unauthorized})).rejects.toThrow();
  });
  it('requires CSRF proof before a shelf write and never sends identity fields',async()=>{
    const fetcher=vi.fn(async (url:RequestInfo|URL,init?:RequestInit)=>{
      if(String(url).endsWith('/csrf'))return new Response(null,{
        status:204,headers:{'x-folio-csrf':'A'.repeat(43)},
      });
      expect(init?.method).toBe('PUT');
      expect(init?.credentials).toBe('same-origin');
      expect(init?.headers).toMatchObject({'x-folio-csrf':'A'.repeat(43)});
      expect(init?.body).toBe(JSON.stringify({status:'to-read'}));
      return new Response(JSON.stringify({saved:true}),{status:200});
    }) as unknown as typeof fetch;
    await expect(saveOwnWebShelf('https://folio.example',id,{status:'to-read'},{fetcher}))
      .resolves.toEqual({saved:true});
    expect(vi.mocked(fetcher).mock.calls).toHaveLength(2);
  });
});
