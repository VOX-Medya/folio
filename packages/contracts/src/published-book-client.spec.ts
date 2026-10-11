import {describe,expect,it,vi} from 'vitest';
import {fetchPublishedBookDetail,PublishedBookHttpError} from './published-book-client.js';

const id='11111111-1111-4111-8111-111111111111';
const editionId='22222222-2222-4222-8222-222222222222';
const revisionId='33333333-3333-4333-8333-333333333333';
const good={
  id,title:'Synthetic published CI book',originalLanguage:'tr',
  authors:[{id:'44444444-4444-4444-8444-444444444444',name:'Folio CI Author'}],
  editions:[{id:editionId,revisionId,language:'tr',label:'CI edition',audioAvailable:false}],
};
describe('published book metadata HTTPS transport',()=>{
  it('uses only GET, no cookie/bearer and validates exact response',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify(good),{
      status:200,headers:{'content-type':'application/json'},
    })) as unknown as typeof fetch;
    const value=await fetchPublishedBookDetail('https://folio.example',id,{fetcher});
    expect(value).toEqual(good);
    const args=vi.mocked(fetcher).mock.calls[0]!;
    expect(args[0]).toBe('https://folio.example/v1/catalog/works/'+id);
    expect(args[1]).toMatchObject({
      method:'GET',credentials:'omit',cache:'no-store',redirect:'error',
      referrerPolicy:'no-referrer',
    });
  });
  it('denies malformed IDs, HTTP transport, response scope and unknown fields',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({...good,secret:'leak'}),{
      status:200,
    })) as unknown as typeof fetch;
    await expect(fetchPublishedBookDetail('https://folio.example','../private',{fetcher}))
      .rejects.toThrow();
    await expect(fetchPublishedBookDetail('http://folio.example',id,{fetcher}))
      .rejects.toThrow();
    await expect(fetchPublishedBookDetail('https://folio.example',id,{fetcher}))
      .rejects.toBeInstanceOf(PublishedBookHttpError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
