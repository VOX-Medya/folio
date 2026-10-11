import {describe,expect,it,vi} from 'vitest';
import {fetchPublishedReaderText,PublishedReaderHttpError} from './published-reader-client.js';

const revisionId='33333333-3333-4333-8333-333333333333';
const text='<script>window.folioOwned=1</script>';
const data={workId:'11111111-1111-4111-8111-111111111111',revisionId,
  title:'Synthetic book',language:'tr',chapters:[{
    id:'22222222-2222-4222-8222-222222222222',heading:'Chapter 1',
    blocks:[{id:'44444444-4444-4444-8444-444444444444',kind:'paragraph',text,includeRsvp:true}],
  }]};
describe('bounded published reader HTTPS transport',()=>{
  it('loads exact revision as literal text with no session credentials or redirect',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify(data),{status:200})) as unknown as typeof fetch;
    const result=await fetchPublishedReaderText('https://folio.example',revisionId,{fetcher});
    expect(result.chapters[0]?.blocks[0]?.text).toBe(text);
    expect(vi.mocked(fetcher).mock.calls[0]).toMatchObject([
      'https://folio.example/v1/catalog/reader/'+revisionId,
      {method:'GET',credentials:'omit',cache:'no-store',redirect:'error'},
    ]);
  });
  it('rejects non-HTTPS, invalid revisions, extra private keys and wrong revisions',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({...data,rawStorageKey:'secret'}),{
      status:200,
    })) as unknown as typeof fetch;
    await expect(fetchPublishedReaderText('http://folio.example',revisionId,{fetcher}))
      .rejects.toThrow();
    await expect(fetchPublishedReaderText('https://folio.example','../draft',{fetcher}))
      .rejects.toThrow();
    await expect(fetchPublishedReaderText('https://folio.example',revisionId,{fetcher}))
      .rejects.toBeInstanceOf(PublishedReaderHttpError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
