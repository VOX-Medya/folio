import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {
  CatalogClientError,catalogErrorText,createAdminAuthor,createAdminWork,
  getAdminAuthor,getAdminWork,patchAdminAuthor,patchAdminWork,
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
  });
});
