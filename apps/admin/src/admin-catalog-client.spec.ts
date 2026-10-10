import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {
  CatalogClientError,catalogErrorText,createAdminAuthor,createAdminWork,
  getAdminAuthor,getAdminWork,patchAdminAuthor,patchAdminWork,
  appendAdminWorkEdition,appendAdminWorkTitle,appendAdminWorkAuthor,
  patchAdminEdition,getAdminRevisionDiff,
  searchAdminAuthors,searchAdminWorks,requireSecureCatalogBrowser,
} from './admin-catalog-client.js';

const authorId='7c2b438c-6ee9-45ad-b817-8ef58ab54c5e';
const workId='40e07813-487e-411c-a5fd-98859098512b';
function json(value:unknown,status=200):Response{
  return new Response(JSON.stringify(value),{
    status,headers:{'content-type':'application/json; charset=utf-8'},
  });
}
function bootstrap():Response{
  return new Response(null,{status:204,headers:{'x-folio-csrf':'B'.repeat(43)}});
}
const authors={items:[{id:authorId,canonicalName:'Şule İpek',sortName:'İpek, Şule'}],nextCursor:null};
const works={items:[{id:workId,originalTitle:'Eser',originalLanguage:'tr',publicationStatus:'draft'}],nextCursor:null};
const authorDetail={
  author:{id:authorId,canonicalName:'Şule İpek',sortName:'İpek, Şule',metadataVersion:2},
  aliases:[{id:workId,name:'Rumuz',locale:'tr'}],
  externalIds:[{source:'test',externalId:'author-1'}],
};
const workDetail={
  work:{id:workId,originalTitle:'Eser',originalLanguage:'tr',
    firstPublicationYear:null,publicationStatus:'draft',metadataVersion:3},
  authors:[{id:authorId,name:'Şule İpek',role:'author',sortOrder:0}],
  titles:[{id:authorId,language:'tr',title:'Eser',kind:'original'}],
  editions:[],
};
beforeEach(()=>{
  vi.stubGlobal('window',{location:{protocol:'https:'}});
  vi.stubGlobal('navigator',{onLine:true});
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('admin catalog browser privacy/transport contract',()=>{
  it('blocks untrusted HTTP and offline sessions before any fetch or credential exposure',async()=>{
    const fetcher=vi.fn();
    vi.stubGlobal('fetch',fetcher);
    vi.stubGlobal('window',{location:{protocol:'http:'}});
    expect(()=>requireSecureCatalogBrowser()).toThrow(CatalogClientError);
    await expect(searchAdminWorks('Eser')).rejects.toMatchObject({kind:'secure-https'});
    await expect(patchAdminAuthor(authorId,{expectedVersion:2,sortName:'New'}))
      .rejects.toMatchObject({kind:'secure-https'});
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubGlobal('window',{location:{protocol:'https:'}});
    vi.stubGlobal('navigator',{onLine:false});
    await expect(searchAdminAuthors('İpek')).rejects.toMatchObject({kind:'offline'});
    await expect(createAdminAuthor({canonicalName:'No Network',aliases:[],externalIds:[]}))
      .rejects.toMatchObject({kind:'offline'});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('queries only bounded author/work metadata with no bearer, credentials persisted or redirects',async()=>{
    const f=vi.fn(async(input:string)=>input.includes('/authors?')
      ?json(authors):json(works));
    vi.stubGlobal('fetch',f);
    expect(await searchAdminAuthors('Şule İpek')).toEqual(authors);
    expect(await searchAdminWorks('Eser % &')).toEqual(works);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0]?.[0]).toContain('q=%C5%9Eule+%C4%B0pek');
    expect(f.mock.calls[1]?.[0]).toContain('q=Eser+%25+%26');
    for(const [,init] of f.mock.calls as unknown as Array<[string,RequestInit]>){
      expect(init).toMatchObject({
        method:'GET',mode:'same-origin',credentials:'same-origin',
        redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',
        headers:{Accept:'application/json'},
      });
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.headers).not.toHaveProperty('x-folio-csrf');
    }
    await expect(searchAdminWorks('')).rejects.toMatchObject({kind:'invalid'});
    await expect(searchAdminAuthors('x'.repeat(121))).rejects.toMatchObject({kind:'invalid'});
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('strictly rejects unknown keys/authorization claims in response bodies',async()=>{
    const f=vi.fn().mockResolvedValueOnce(json({...works,adminRoles:['superadmin']}))
      .mockResolvedValueOnce(json({...authorDetail,userId:authorId}))
      .mockResolvedValueOnce(json(workDetail));
    vi.stubGlobal('fetch',f);
    await expect(searchAdminWorks('Eser')).rejects.toMatchObject({kind:'unexpected'});
    await expect(getAdminAuthor(authorId)).rejects.toMatchObject({kind:'unexpected'});
    expect((await getAdminWork(workId)).work.metadataVersion).toBe(3);
    await expect(getAdminWork('../private')).rejects.toMatchObject({kind:'invalid'});
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('bootstraps ephemeral same-origin HMAC-CSRF per edit and sends no bearer or raw account header',async()=>{
    const f=vi.fn(async(input:string,init:RequestInit)=>{
      if(input==='/v1/auth/web/csrf')return bootstrap();
      if(input==='/v1/admin/catalog/authors'&&init.method==='POST')return json({id:authorId},201);
      if(input==='/v1/admin/catalog/works/'+workId&&init.method==='PATCH'){
        return json({id:workId,metadataVersion:4,publicationStatus:'draft'});
      }
      throw Error('Unexpected request '+input);
    });
    vi.stubGlobal('fetch',f);
    expect(await createAdminAuthor({
      canonicalName:'Editor',sortName:'Editor',aliases:[],externalIds:[],
    })).toEqual({id:authorId});
    expect(await patchAdminWork(workId,{expectedVersion:3,originalTitle:'Edited'}))
      .toEqual({id:workId,metadataVersion:4,publicationStatus:'draft'});
    expect(f).toHaveBeenCalledTimes(4);
    for(const i of [1,3]){
      const [path,init]=f.mock.calls[i]!;
      expect(path).toMatch(/^\/v1\/admin\/catalog\//);
      expect(init).toMatchObject({
        method:i===1?'POST':'PATCH',mode:'same-origin',
        credentials:'same-origin',redirect:'error',
        cache:'no-store',referrerPolicy:'no-referrer',
      });
      expect((init.headers as Record<string,string>)['x-folio-csrf']).toBe('B'.repeat(43));
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.headers).not.toHaveProperty('x-user-id');
      expect(init.headers).not.toHaveProperty('x-admin-role');
      expect(init.headers).not.toHaveProperty('x-request-id');
      expect(JSON.stringify(init)).not.toContain('Bearer');
    }
    expect(f.mock.calls[0]?.[0]).toBe('/v1/auth/web/csrf');
    expect(f.mock.calls[2]?.[0]).toBe('/v1/auth/web/csrf');
  });
  it('rejects stale edits with 409 without resending and reports verified-identity failures',async()=>{
    const f=vi.fn().mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(json({error:{code:'CONFLICT'}},409))
      .mockResolvedValueOnce(json({error:{code:'UNAUTHORIZED'}},401))
      .mockResolvedValueOnce(json({error:{code:'FORBIDDEN'}},403))
      .mockResolvedValueOnce(json({error:{code:'NOT_FOUND'}},404));
    vi.stubGlobal('fetch',f);
    await expect(patchAdminAuthor(authorId,{
      expectedVersion:2,canonicalName:'Conflict',
    })).rejects.toMatchObject({kind:'conflict'});
    expect(f).toHaveBeenCalledTimes(2);
    await expect(searchAdminAuthors('author')).rejects.toMatchObject({kind:'unauthorized'});
    await expect(searchAdminWorks('work')).rejects.toMatchObject({kind:'forbidden'});
    await expect(getAdminWork(workId)).rejects.toMatchObject({kind:'not-found'});
    expect(f).toHaveBeenCalledTimes(5);
    expect(catalogErrorText(new CatalogClientError('conflict'),'tr'))
      .toContain('Başka bir yönetici');
    expect(catalogErrorText(new CatalogClientError('conflict'),'en'))
      .toContain('Another editor');
  });
  it('validates create and patch DTOs locally; no arbitrary publication/owner or text',async()=>{
    const f=vi.fn();
    vi.stubGlobal('fetch',f);
    await expect(createAdminWork({
      originalTitle:'No author',originalLanguage:'tr',authors:[],titles:[],editions:[],
    })).rejects.toMatchObject({kind:'invalid'});
    await expect(createAdminWork({
      originalTitle:'No author',originalLanguage:'tr',authors:[{
        authorId:'bad',contribution:'author',sortOrder:0,
      }],titles:[],editions:[],
    })).rejects.toMatchObject({kind:'invalid'});
    await expect(patchAdminWork(workId,{
      expectedVersion:3,publicationStatus:'published',
    } as never)).rejects.toMatchObject({kind:'invalid'});
    await expect(patchAdminAuthor(authorId,{
      expectedVersion:2,aliases:[{name:'Alias',userId:authorId}],
    } as never)).rejects.toMatchObject({kind:'invalid'});
    expect(f).not.toHaveBeenCalled();
  });  it('appends bounded DRAFT edition/title/coauthor only with fresh HMAC-CSRF and exact revision',async()=>{
    const calls:Array<{url:string;method:string;body:Record<string,unknown>|null;csrf:string|undefined}>=[];
    let version=1;
    const f=vi.fn(async(url:string,init:RequestInit)=>{
      if(url==='/v1/auth/web/csrf')return bootstrap();
      const body=JSON.parse(String(init.body)) as Record<string,unknown>;
      calls.push({url,method:String(init.method),body,
        csrf:(init.headers as Record<string,string>)['x-folio-csrf']});
      if(url.endsWith('/editions'))return json({
        id:authorId,workId,metadataVersion:++version,status:'draft',
      },201);
      if(url.endsWith('/titles'))return json({
        id:authorId,workId,metadataVersion:++version,
      },201);
      if(url.endsWith('/authors'))return json({
        workId,authorId,metadataVersion:++version,
      },201);
      throw Error('Unexpected network path');
    });
    vi.stubGlobal('fetch',f);
    expect(await appendAdminWorkEdition(workId,{
      expectedVersion:1,language:'en',label:'Translation, first print',
      identifiers:[{kind:'isbn-13',value:'9780123456789'}],
      contributors:[{authorId,role:'translator',sortOrder:0}],
    })).toEqual({id:authorId,workId,metadataVersion:2,status:'draft'});
    expect(await appendAdminWorkTitle(workId,{
      expectedVersion:2,language:'tr',title:'Alternatif',kind:'alternate',
    })).toEqual({id:authorId,workId,metadataVersion:3});
    expect(await appendAdminWorkAuthor(workId,{
      expectedVersion:3,authorId,contribution:'co-author',sortOrder:1,
    })).toEqual({workId,authorId,metadataVersion:4});
    expect(f).toHaveBeenCalledTimes(6);
    expect(calls.map(v=>v.url)).toEqual([
      '/v1/admin/catalog/works/'+workId+'/editions',
      '/v1/admin/catalog/works/'+workId+'/titles',
      '/v1/admin/catalog/works/'+workId+'/authors',
    ]);
    for(const call of calls){
      expect(call.csrf).toBe('B'.repeat(43));
      expect(call.method).toBe('POST');
      expect(call.body).not.toHaveProperty('publicationStatus');
      expect(call.body).not.toHaveProperty('actorId');
      expect(call.body).not.toHaveProperty('userId');
    }
    expect(calls[0]?.body?.expectedVersion).toBe(1);
    expect(calls[1]?.body?.expectedVersion).toBe(2);
    expect(calls[2]?.body?.expectedVersion).toBe(3);
  });
  it('rejects invalid relation, fake publication, missing author before any fetch/CSRF',async()=>{
    const f=vi.fn();
    vi.stubGlobal('fetch',f);
    await expect(appendAdminWorkEdition(workId,{
      expectedVersion:0,language:'en',label:'Draft',
      identifiers:[{kind:'isbn-13',value:'dup'},{kind:'isbn-13',value:'dup'}],
      contributors:[],
    })).rejects.toMatchObject({kind:'invalid'});
    await expect(appendAdminWorkTitle(workId,{
      expectedVersion:0,language:'en',title:'Translation',kind:'original',
    } as never)).rejects.toMatchObject({kind:'invalid'});
    await expect(appendAdminWorkAuthor(workId,{
      expectedVersion:0,authorId:'not-uuid',contribution:'author',sortOrder:0,
    })).rejects.toMatchObject({kind:'invalid'});
    await expect(appendAdminWorkEdition(workId,{
      expectedVersion:0,language:'en',label:'Draft',
      identifiers:[],contributors:[],status:'published',
    } as never)).rejects.toMatchObject({kind:'invalid'});
    await expect(appendAdminWorkEdition('../cross-site',{
      expectedVersion:0,language:'tr',label:'Draft',identifiers:[],contributors:[],
    })).rejects.toMatchObject({kind:'invalid'});
    expect(f).not.toHaveBeenCalled();
  });
  it('does not retry a stale append after server replies with 409 or network failure',async()=>{
    const f=vi.fn()
      .mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(json({error:{code:'CONFLICT'}},409))
      .mockResolvedValueOnce(bootstrap())
      .mockRejectedValueOnce(new Error('response lost after commit'));
    vi.stubGlobal('fetch',f);
    const input={expectedVersion:5,language:'en' as const,
      label:'Concurrent edition',identifiers:[],contributors:[]};
    await expect(appendAdminWorkEdition(workId,input)).rejects.toMatchObject({
      kind:'conflict',
    });
    expect(f).toHaveBeenCalledTimes(2);
    await expect(appendAdminWorkEdition(workId,input)).rejects.toMatchObject({
      kind:'network',
    });
    expect(f).toHaveBeenCalledTimes(4);
  });
  it('edits only DRAFT edition metadata over a fresh verified Web CSRF PATCH and never sends actor/publish',async()=>{
    const f=vi.fn(async(url:string,init:RequestInit)=>{
      if(url==='/v1/auth/web/csrf')return bootstrap();
      if(url==='/v1/admin/catalog/works/'+workId+'/editions/'+authorId){
        expect(init).toMatchObject({
          method:'PATCH',mode:'same-origin',credentials:'same-origin',
          redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',
        });
        const headers=init.headers as Record<string,string>;
        expect(headers['x-folio-csrf']).toBe('B'.repeat(43));
        expect(headers).not.toHaveProperty('Authorization');
        expect(headers).not.toHaveProperty('x-user-id');
        const body=JSON.parse(String(init.body)) as Record<string,unknown>;
        expect(body).toEqual({
          expectedVersion:5,label:'Corrected edition',
          publisher:null,
          identifiers:[{kind:'other',value:'folio-local'}],
          contributors:[{authorId,role:'translator',sortOrder:1}],
        });
        return json({id:authorId,workId,metadataVersion:6,status:'draft'});
      }
      throw Error('Unexpected path');
    });
    vi.stubGlobal('fetch',f);
    expect(await patchAdminEdition(workId,authorId,{
      expectedVersion:5,label:'Corrected edition',publisher:null,
      identifiers:[{kind:'other',value:'folio-local'}],
      contributors:[{authorId,role:'translator',sortOrder:1}],
    })).toEqual({id:authorId,workId,metadataVersion:6,status:'draft'});
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('rejects stale edition edit and illicit publication/language before transport; no silent retry',async()=>{
    const f=vi.fn().mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(json({error:{code:'CONFLICT'}},409));
    vi.stubGlobal('fetch',f);
    await expect(patchAdminEdition(workId,authorId,{
      expectedVersion:5,label:'Stale edited edition',
    })).rejects.toMatchObject({kind:'conflict'});
    expect(f).toHaveBeenCalledTimes(2);
    await expect(patchAdminEdition(workId,authorId,{
      expectedVersion:5,label:'Illicit',status:'published',
    } as never)).rejects.toMatchObject({kind:'invalid'});
    await expect(patchAdminEdition(workId,authorId,{
      expectedVersion:5,label:'Other language',language:'fr',
    } as never)).rejects.toMatchObject({kind:'invalid'});
    await expect(patchAdminEdition(workId,'../bad',{
      expectedVersion:5,label:'Untrusted ID',
    })).rejects.toMatchObject({kind:'invalid'});
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('reads an edition-scoped SHA-only diff over same-origin HTTPS GET without CSRF or a bearer',async()=>{
    const fromRevisionId='f5612fc5-767e-4dc9-86e4-4f636f2f84a1';
    const toRevisionId='5bfcad92-5fa8-4acb-b6ac-bb5e6f203e9a';
    const cursorId='05e3d7bc-d7c3-44a3-b58f-b342714f8304';
    const diff={
      editionId:authorId,fromRevisionId,toRevisionId,
      summary:{added:1,removed:0,text_changed:0,metadata_changed:0,moved:0,unchanged:0},
      chapterChanges:[],
      items:[{blockId:cursorId,kind:'added',before:null,
        after:{chapterId:workId,ordinal:0,kind:'paragraph',
          textSha256:'a'.repeat(64),includeNormal:true,
          includeRsvp:true,includeAudio:false}}],
      nextCursor:null,isMetadataOnly:true,
    };
    const fetcher=vi.fn(async()=>json(diff));
    vi.stubGlobal('fetch',fetcher);
    expect(await getAdminRevisionDiff(workId,authorId,fromRevisionId,toRevisionId))
      .toEqual(diff);
    const [path,init]=fetcher.mock.calls[0]!;
    expect(path).toBe('/v1/admin/catalog/works/'+workId+'/editions/'+authorId+
      '/revisions/'+toRevisionId+'/diff?fromRevisionId='+fromRevisionId+'&limit=50');
    expect(init).toMatchObject({
      method:'GET',mode:'same-origin',credentials:'same-origin',
      redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',
      headers:{Accept:'application/json'},
    });
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.headers).not.toHaveProperty('x-folio-csrf');
    expect(JSON.stringify(diff)).not.toContain('sourceText');
    await getAdminRevisionDiff(workId,authorId,fromRevisionId,toRevisionId,cursorId);
    expect(fetcher.mock.calls[1]?.[0]).toContain('&cursor='+cursorId);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects revision UUID injection, response leakage and cross-scope metadata without retry',async()=>{
    const from='f5612fc5-767e-4dc9-86e4-4f636f2f84a1';
    const to='5bfcad92-5fa8-4acb-b6ac-bb5e6f203e9a';
    const valid={
      editionId:authorId,fromRevisionId:from,toRevisionId:to,
      summary:{added:0,removed:0,text_changed:0,metadata_changed:0,moved:0,unchanged:1},
      chapterChanges:[],items:[],nextCursor:null,isMetadataOnly:true,
    };
    const fetcher=vi.fn().mockResolvedValueOnce(json({...valid,sourceText:'LEAK'}))
      .mockResolvedValueOnce(json({...valid,editionId:workId}))
      .mockResolvedValueOnce(json(valid,403))
      .mockRejectedValueOnce(Error('connection reset'));
    vi.stubGlobal('fetch',fetcher);
    await expect(getAdminRevisionDiff(workId,authorId,'../private',to))
      .rejects.toMatchObject({kind:'invalid'});
    await expect(getAdminRevisionDiff(workId,authorId,from,from))
      .rejects.toMatchObject({kind:'invalid'});
    await expect(getAdminRevisionDiff(workId,authorId,from,to,'../../bad'))
      .rejects.toMatchObject({kind:'invalid'});
    expect(fetcher).not.toHaveBeenCalled();
    await expect(getAdminRevisionDiff(workId,authorId,from,to))
      .rejects.toMatchObject({kind:'unexpected'});
    await expect(getAdminRevisionDiff(workId,authorId,from,to))
      .rejects.toMatchObject({kind:'unexpected'});
    await expect(getAdminRevisionDiff(workId,authorId,from,to))
      .rejects.toMatchObject({kind:'forbidden'});
    await expect(getAdminRevisionDiff(workId,authorId,from,to))
      .rejects.toMatchObject({kind:'network'});
    expect(fetcher).toHaveBeenCalledTimes(4);
    vi.stubGlobal('window',{location:{protocol:'http:'}});
    await expect(getAdminRevisionDiff(workId,authorId,from,to))
      .rejects.toMatchObject({kind:'secure-https'});
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

});
