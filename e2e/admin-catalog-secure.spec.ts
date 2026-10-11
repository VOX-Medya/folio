import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:https';
import type {Server} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';

/** Browser UX tests use an ephemeral HTTPS reverse proxy over the Vite test
 * server and explicitly mocked API responses. Real admin authority and
 * PostgreSQL audit/CSRF are verified separately in admin-catalog-https-smoke.
 * No mock catalog is ever injected into app production code. */
test.use({ignoreHTTPSErrors:true});
let proxy:Server;
let root:string;
let temp:string;
test.beforeAll(async()=>{
  temp=mkdtempSync(join(tmpdir(),'folio-admin-https-browser-'));
  const key=join(temp,'key.pem'),cert=join(temp,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],
  {stdio:'ignore'});
  proxy=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
    const upstream=httpRequest({
      hostname:'127.0.0.1',port:4173,method:req.method,path:req.url,
      headers:{...req.headers,host:'127.0.0.1:4173'},
    },response=>{
      res.writeHead(response.statusCode??502,response.headers);
      response.pipe(res);
    });
    upstream.once('error',()=>{
      if(!res.headersSent)res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve,reject)=>{
    proxy.once('error',reject);
    proxy.listen(0,'127.0.0.1',()=>resolve());
  });
  const addr=proxy.address() as AddressInfo;
  root='https://127.0.0.1:'+addr.port;
});
test.afterAll(async()=>{
  if(proxy){
    proxy.closeAllConnections();
    await new Promise<void>(resolve=>proxy.close(()=>resolve()));
  }
  if(temp)rmSync(temp,{recursive:true,force:true});
});
function respond(data:unknown,status=200){
  return {status,contentType:'application/json',body:JSON.stringify(data)};
}
const authorId='7c2b438c-6ee9-45ad-b817-8ef58ab54c5e';
const workId='40e07813-487e-411c-a5fd-98859098512b';
const createdAuthorId='2bbdef86-2af8-4666-9b27-3e9d44bfb222';

test('real HTTPS Paperbound workspace retries stale work edit only AFTER explicit reload',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  let version=1,title='Kayıtlı Taslak';
  const year:number|null=null;
  const writes:Array<Record<string,unknown>>=[];
  const methods:string[]=[];
  await page.route('**/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    methods.push(request.method()+' '+url.pathname);
    if(url.pathname==='/v1/auth/web/csrf'){
      await route.fulfill({status:204,headers:{'x-folio-csrf':'C'.repeat(43)}});
    }else if(url.pathname==='/v1/admin/catalog/works'&&request.method()==='GET'){
      await route.fulfill(respond({items:[{id:workId,originalTitle:'Kayıtlı Taslak',
        originalLanguage:'tr',publicationStatus:'draft'}],nextCursor:null}));
    }else if(url.pathname==='/v1/admin/catalog/works/'+workId&&request.method()==='GET'){
      await route.fulfill(respond({
        work:{id:workId,originalTitle:title,originalLanguage:'tr',
          firstPublicationYear:year,publicationStatus:'draft',metadataVersion:version},
        authors:[{id:authorId,name:'Şule İpek',role:'author',sortOrder:0}],
        titles:[{id:authorId,language:'tr',title,kind:'original'}],
        editions:[],
      }));
    }else if(url.pathname==='/v1/admin/catalog/works/'+workId&&request.method()==='PATCH'){
      const body=request.postDataJSON() as Record<string,unknown>;
      writes.push(body);
      expect(request.headers()['authorization']).toBeUndefined();
      expect(request.headers()['x-folio-csrf']).toBe('C'.repeat(43));
      expect(request.headers()['x-admin-role']).toBeUndefined();
      if(writes.length===1){
        // Someone else committed before this client. The client MUST NOT retry.
        version=2;title='Başka yöneticinin düzeltmesi';
        await route.fulfill(respond({error:{code:'CONFLICT'}},409));
      }else{
        expect(body.expectedVersion).toBe(2);
        version=3;title=body.originalTitle as string;
        await route.fulfill(respond({id:workId,metadataVersion:3,publicationStatus:'draft'}));
      }
    }else{
      await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
    }
  });
  await page.goto(root+'/admin/works');
  await expect(page.getByTestId('admin-catalog-panel')).toBeVisible();
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Taslak');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/Kayıtlı Taslak/}).click();
  const details=page.getByTestId('admin-catalog-detail');
  await expect(details).toContainText('Metadata sürümü: 1');
  await expect(details).toContainText('Şule İpek');
  await page.getByRole('button',{name:'Metadata düzenle'}).click();
  await page.getByLabel('Özgün başlık').fill('Eski sürümden değişiklik');
  await page.getByRole('button',{name:'Sürüm kontrolüyle kaydet'}).click();
  await expect(details.getByRole('alert')).toContainText('Kaydı sessizce tekrar göndermeyin');
  expect(writes).toHaveLength(1);
  await page.getByRole('button',{name:'Güncel sürümü sunucudan yükle'}).click();
  await expect(details).toContainText('Metadata sürümü: 2');
  await expect(details).toContainText('Başka yöneticinin düzeltmesi');
  expect(writes).toHaveLength(1);
  await page.getByRole('button',{name:'Metadata düzenle'}).click();
  await page.getByLabel('Özgün başlık').fill('Gözden geçirilmiş taslak');
  await page.getByRole('button',{name:'Sürüm kontrolüyle kaydet'}).click();
  await expect(details).toContainText('Metadata sürümü: 3');
  await expect(details).toContainText('Gözden geçirilmiş taslak');
  expect(writes).toHaveLength(2);
  expect(writes[0]?.expectedVersion).toBe(1);
  expect(writes[1]?.expectedVersion).toBe(2);
  expect(methods.filter(method=>method==='GET /v1/auth/web/csrf')).toHaveLength(2);
  await page.getByRole('button',{name:'EN',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Works'})).toBeVisible();
  await expect(details).toContainText('Metadata version: 3');
});

test('author alias/source editing + real create form are responsive, typed and server-confirmed',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let selectedId=authorId,version=0,name='Çiğdem Öğüt';
  let aliases:Array<{id:string;name:string;locale:string|null}>=[];
  let ids:Array<{source:string;externalId:string}>=[];
  const writes:Array<Record<string,unknown>>=[];
  await page.route('**/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method();
    if(url.pathname==='/v1/auth/web/csrf'){
      await route.fulfill({status:204,headers:{'x-folio-csrf':'D'.repeat(43)}});
    }else if(url.pathname==='/v1/admin/catalog/authors'&&method==='GET'){
      await route.fulfill(respond({items:[{id:authorId,
        canonicalName:'Çiğdem Öğüt',sortName:'Öğüt, Çiğdem'}],nextCursor:null}));
    }else if(url.pathname==='/v1/admin/catalog/authors'&&method==='POST'){
      const body=req.postDataJSON() as Record<string,unknown>;
      writes.push(body);
      expect(body).not.toHaveProperty('publicationStatus');
      expect(body).not.toHaveProperty('actorId');
      selectedId=createdAuthorId;version=0;name=body.canonicalName as string;
      aliases=[];ids=[];
      await route.fulfill(respond({id:createdAuthorId},201));
    }else if(url.pathname==='/v1/admin/catalog/authors/'+selectedId&&method==='GET'){
      await route.fulfill(respond({
        author:{id:selectedId,canonicalName:name,
          sortName:selectedId===authorId?'Öğüt, Çiğdem':name,metadataVersion:version},
        aliases,externalIds:ids,
      }));
    }else if(url.pathname==='/v1/admin/catalog/authors/'+authorId&&method==='PATCH'){
      const body=req.postDataJSON() as Record<string,unknown>;
      writes.push(body);
      expect(req.headers()['x-folio-csrf']).toBe('D'.repeat(43));
      expect(body.expectedVersion).toBe(0);
      expect(body).not.toHaveProperty('authorId');
      expect(body).not.toHaveProperty('role');
      aliases=(body.aliases as Array<{name:string;locale:string}>)
        .map((x,index)=>({id:index===0?workId:createdAuthorId,...x}));
      ids=body.externalIds as Array<{source:string;externalId:string}>;
      version=1;
      await route.fulfill(respond({id:authorId,metadataVersion:1}));
    }else{
      await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
    }
  });
  await page.goto(root+'/admin/authors');
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Öğüt');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/Çiğdem Öğüt/}).click();
  const details=page.getByTestId('admin-catalog-detail');
  await expect(details).toContainText('Metadata sürümü: 0');
  await page.getByRole('button',{name:'Metadata düzenle'}).click();
  await page.getByRole('button',{name:'Takma ad ekle'}).click();
  await page.getByRole('textbox',{name:'Takma ad 1'}).fill('Çiğdem');
  await page.getByRole('textbox',{name:'Takma ad dili 1'}).fill('tr');
  await page.getByRole('button',{name:'Kaynak kimliği ekle'}).click();
  await page.getByRole('textbox',{name:'Kaynak 1'}).fill('folio_ci');
  await page.getByRole('textbox',{name:'Kaynak kimliği 1'}).fill('author-case');
  await page.getByRole('button',{name:'Sürüm kontrolüyle kaydet'}).click();
  await expect(details).toContainText('Metadata sürümü: 1');
  await expect(details).toContainText('author-case');
  expect(writes[0]).toMatchObject({
    expectedVersion:0,
    aliases:[{name:'Çiğdem',locale:'tr'}],
    externalIds:[{source:'folio_ci',externalId:'author-case'}],
  });
  await page.getByRole('button',{name:'Yeni taslak oluştur'}).click();
  await page.getByLabel('Kanonik yazar adı').fill('Yeni Yazar');
  await page.getByRole('button',{name:'Taslağı kaydet'}).click();
  await expect(details).toContainText('Yeni Yazar');
  expect(writes[1]).toMatchObject({canonicalName:'Yeni Yazar',aliases:[],externalIds:[]});
  const viewportOverflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  expect(viewportOverflow).toBeLessThanOrEqual(1);
});


test('HTTP preview never asks for private author or work data',async({page})=>{
  const intercepted:string[]=[];
  await page.route('**/v1/**',async route=>{
    intercepted.push(route.request().url());
    await route.abort();
  });
  for(const kind of ['works','authors']){
    await page.goto('http://127.0.0.1:4173/admin/'+kind);
    await expect(page.getByTestId('admin-catalog-insecure')).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Taslağı kaydet'})).toHaveCount(0);
  }
  expect(intercepted).toEqual([]);
});

test('HTTPS catalog never renders simulated results after a real 403 permission response',async({page})=>{
  await page.setViewportSize({width:320,height:720});
  let queries=0;
  await page.route('**/v1/**',async route=>{
    queries++;
    await route.fulfill(respond({error:{code:'FORBIDDEN'}},403));
  });
  await page.goto(root+'/admin/works');
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Özel Taslak');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await expect(page.getByRole('alert').first())
    .toContainText('Yönetici rolü ve bu cihazda geçerli MFA');
  await expect(page.getByTestId('admin-catalog-detail')).toHaveCount(0);
  await expect(page.getByText('Özel Taslak',{exact:true})).toHaveCount(0);
  expect(queries).toBe(1);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});


test('HTTPS author, edition, ISBN, translator and alternate-title work relations follow server revisions',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let version=0,conflictSent=false;
  const inputs:Array<{path:string;body:Record<string,unknown>;csrf:string|undefined}>=[];
  const editions:Array<Record<string,unknown>>=[];
  const titles:Array<Record<string,unknown>>=[{
    id:authorId,language:'tr',title:'Kayıtlı Taslak',kind:'original',
  }];
  const authors:Array<Record<string,unknown>>=[{
    id:authorId,name:'Şule İpek',role:'author',sortOrder:0,
  }];
  await page.route('**/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(path==='/v1/auth/web/csrf'){
      await route.fulfill({status:204,headers:{'x-folio-csrf':'D'.repeat(43)}});
    }else if(path==='/v1/admin/catalog/works'&&request.method()==='GET'){
      await route.fulfill(respond({items:[{
        id:workId,originalTitle:'Kayıtlı Taslak',
        originalLanguage:'tr',publicationStatus:'draft',
      }],nextCursor:null}));
    }else if(path==='/v1/admin/catalog/works/'+workId&&request.method()==='GET'){
      await route.fulfill(respond({
        work:{id:workId,originalTitle:'Kayıtlı Taslak',originalLanguage:'tr',
          firstPublicationYear:null,publicationStatus:'draft',metadataVersion:version},
        authors,titles,editions,
      }));
    }else if(path.startsWith('/v1/admin/catalog/works/'+workId+'/')&&
      request.method()==='POST'){
      const body=request.postDataJSON() as Record<string,unknown>;
      inputs.push({path,body,csrf:request.headers()['x-folio-csrf']});
      expect(request.headers()['authorization']).toBeUndefined();
      expect(request.headers()['x-user-id']).toBeUndefined();
      expect(request.headers()['x-admin-role']).toBeUndefined();
      if(path.endsWith('/editions')){
        expect(body.expectedVersion).toBe(0);
        expect(body).not.toHaveProperty('publicationStatus');
        editions.push({
          id:createdAuthorId,language:body.language,label:body.label,
          publisher:body.publisher??null,status:'draft',
          identifiers:body.identifiers,contributors:body.contributors,
        });
        version=1;
        await route.fulfill(respond({
          id:createdAuthorId,workId,metadataVersion:1,status:'draft',
        },201));
      }else if(path.endsWith('/titles')){
        if(!conflictSent){
          conflictSent=true;
          // A competing editor committed another revision on the server.
          version=2;
          titles.push({id:createdAuthorId,language:'en',
            title:'Başka editörün başlığı',kind:'alternate'});
          await route.fulfill(respond({error:{code:'CONFLICT'}},409));
        }else{
          expect(body.expectedVersion).toBe(2);
          version=3;
          titles.push({
            id:'822ab87e-bb66-4a60-a6fb-6675c1dba21b',
            language:body.language,title:body.title,kind:body.kind,
          });
          await route.fulfill(respond({
            id:'822ab87e-bb66-4a60-a6fb-6675c1dba21b',
            workId,metadataVersion:3,
          },201));
        }
      }else if(path.endsWith('/authors')){
        expect(body.expectedVersion).toBe(3);
        version=4;
        authors.push({
          id:createdAuthorId,name:'İkinci Yazar',role:body.contribution,
          sortOrder:body.sortOrder,
        });
        await route.fulfill(respond({
          workId,authorId:createdAuthorId,metadataVersion:4,
        },201));
      }else{
        await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
      }
    }else{
      await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
    }
  });
  await page.goto(root+'/admin/works');
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Taslak');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/Kayıtlı Taslak/}).click();
  const details=page.getByTestId('admin-catalog-detail');
  await expect(details).toContainText('Metadata sürümü: 0');
  const panel=page.getByTestId('admin-work-relations');
  await page.getByRole('button',{name:'Baskı ekle'}).click();
  await page.getByLabel('Baskı etiketi').fill('İlk İngilizce Baskı');
  await page.getByLabel('Yayınevi (isteğe bağlı)').fill('Folio Lab');
  await page.getByRole('button',{name:'Tanımlayıcı ekle'}).click();
  await page.getByRole('combobox',{name:'Tür 1'}).selectOption('isbn-13');
  await page.getByRole('textbox',{name:'Değer 1'}).fill('9780123456789');
  await page.getByRole('button',{name:'Tanımlayıcı ekle'}).click();
  await page.getByRole('combobox',{name:'Tür 2'}).selectOption('other');
  await page.getByRole('textbox',{name:'Değer 2'}).fill('folio:edition:sample');
  await page.getByRole('button',{name:'Katkı veren ekle'}).click();
  await page.getByRole('textbox',{name:'Kanonik yazar UUID 1'}).fill(authorId);
  await page.getByRole('combobox',{name:'Baskı katkı görevi 1'}).selectOption('translator');
  await page.getByRole('button',{name:'Sürüm kontrolüyle ekle'}).click();
  await expect(details).toContainText('Metadata sürümü: 1');
  await expect(details).toContainText('İlk İngilizce Baskı');
  await expect(details).toContainText('9780123456789');
  expect(inputs[0]?.body).toMatchObject({
    expectedVersion:0,language:'en',label:'İlk İngilizce Baskı',
    publisher:'Folio Lab',
    identifiers:[
      {kind:'isbn-13',value:'9780123456789'},
      {kind:'other',value:'folio:edition:sample'},
    ],
    contributors:[{authorId,role:'translator',sortOrder:0}],
  });
  await panel.getByRole('button',{name:'Alternatif başlık ekle'}).click();
  await page.getByRole('textbox',{name:'Başlık',exact:true}).fill('A New Translation Title');
  await page.getByRole('combobox',{name:'Başlık türü'}).selectOption('translation');
  await panel.getByRole('button',{name:'Sürüm kontrolüyle ekle'}).click();
  await expect(panel.getByRole('alert')).toContainText('Başka bir yönetici');
  const writesBeforeReload=inputs.length;
  await expect(panel.getByRole('button',{name:'Sürüm kontrolüyle ekle'})).toBeDisabled();
  expect(inputs.length).toBe(writesBeforeReload);
  await panel.getByRole('button',{name:'Güncel eseri yeniden yükle'}).click();
  await expect(details).toContainText('Metadata sürümü: 2');
  await expect(details).toContainText('Başka editörün başlığı');
  expect(inputs.length).toBe(writesBeforeReload);
  await page.getByRole('button',{name:'Alternatif başlık ekle'}).click();
  await page.getByRole('textbox',{name:'Başlık',exact:true}).fill('Verified Translation Title');
  await page.getByRole('combobox',{name:'Başlık türü'}).selectOption('translation');
  await page.getByRole('button',{name:'Sürüm kontrolüyle ekle'}).click();
  await expect(details).toContainText('Metadata sürümü: 3');
  await expect(details).toContainText('Verified Translation Title');
  await page.getByRole('button',{name:'Yazar bağla'}).click();
  await page.getByLabel('Kanonik yazar UUID',{exact:true}).fill(createdAuthorId);
  await page.getByRole('combobox',{name:'Katkı türü'}).selectOption('co-author');
  await page.getByRole('textbox',{name:'Sıra',exact:true}).fill('2');
  await page.getByRole('button',{name:'Sürüm kontrolüyle ekle'}).click();
  await expect(details).toContainText('Metadata sürümü: 4');
  await expect(details).toContainText('İkinci Yazar (co-author, 2)');
  expect(inputs).toHaveLength(4);
  expect(inputs.map(i=>i.csrf)).toEqual(Array(4).fill('D'.repeat(43)));
  expect(inputs[2]?.body).toMatchObject({
    expectedVersion:2,kind:'translation',title:'Verified Translation Title',
  });
  expect(inputs[3]?.body).toMatchObject({
    expectedVersion:3,authorId:createdAuthorId,contribution:'co-author',sortOrder:2,
  });
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'EN',exact:true}).click();
  await expect(page.getByTestId('admin-work-relations'))
    .toContainText('Draft work relationships');
});


test('HTTPS existing DRAFT edition metadata edit rejects stale revision, FK/title changes and reloads correctly',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let version=1,conflicted=false,label='First Edition',publisher:string|null='Folio Press';
  let identifiers=[{kind:'isbn-13',value:'9780123456789'},
    {kind:'other',value:'folio:first-print'}];
  let contributors=[{authorId,role:'translator',sortOrder:0}];
  const writes:Array<{body:Record<string,unknown>;csrf:string|undefined}>=[];
  await page.route('**/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/v1/auth/web/csrf'){
      await route.fulfill({status:204,headers:{'x-folio-csrf':'F'.repeat(43)}});
    }else if(path==='/v1/admin/catalog/works'&&request.method()==='GET'){
      await route.fulfill(respond({items:[{
        id:workId,originalTitle:'Canonical Work',originalLanguage:'tr',
        publicationStatus:'draft',
      }],nextCursor:null}));
    }else if(path==='/v1/admin/catalog/works/'+workId&&request.method()==='GET'){
      await route.fulfill(respond({
        work:{id:workId,originalTitle:'Canonical Work',originalLanguage:'tr',
          firstPublicationYear:1912,publicationStatus:'draft',metadataVersion:version},
        authors:[{id:authorId,name:'Şule İpek',role:'author',sortOrder:0}],
        titles:[{id:authorId,language:'tr',title:'Canonical Work',kind:'original'}],
        editions:[{
          id:createdAuthorId,language:'en',label,publisher,
          status:'draft',identifiers,contributors,
        }],
      }));
    }else if(path==='/v1/admin/catalog/works/'+workId+'/editions/'+createdAuthorId&&
      request.method()==='PATCH'){
      const body=request.postDataJSON() as Record<string,unknown>;
      writes.push({body,csrf:request.headers()['x-folio-csrf']});
      expect(request.headers()['authorization']).toBeUndefined();
      expect(request.headers()['x-user-id']).toBeUndefined();
      expect(body).not.toHaveProperty('status');
      expect(body).not.toHaveProperty('language');
      expect(body).not.toHaveProperty('rightsApproved');
      if(!conflicted){
        conflicted=true;
        version=2;label='Another Editor Revised Label';
        await route.fulfill(respond({error:{code:'CONFLICT'}},409));
      }else{
        expect(body.expectedVersion).toBe(2);
        version=3;label=body.label as string;
        publisher=body.publisher as string|null;
        identifiers=body.identifiers as typeof identifiers;
        contributors=body.contributors as typeof contributors;
        await route.fulfill(respond({
          id:createdAuthorId,workId,metadataVersion:3,status:'draft',
        }));
      }
    }else{
      await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
    }
  });
  await page.goto(root+'/admin/works');
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Canonical');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/Canonical Work/}).click();
  const detail=page.getByTestId('admin-catalog-detail');
  await expect(detail).toContainText('First Edition');
  await page.getByRole('button',{name:'Taslak baskıyı düzenle'}).click();
  let editor=page.getByTestId('admin-edition-editor');
  await expect(editor).toContainText('Beklenen eser sürümü: 1');
  await page.getByRole('textbox',{name:'Baskı etiketi'}).fill('Outdated proposal');
  await editor.getByRole('button',{name:'Sürüm kontrollü kaydet'}).click();
  await expect(editor.getByRole('alert')).toContainText('Başka bir yönetici');
  await expect(editor.getByRole('button',{name:'Sürüm kontrollü kaydet'})).toBeDisabled();
  expect(writes).toHaveLength(1);
  await editor.getByRole('button',{name:'Güncel baskıyı sunucudan yükle'}).click();
  await expect(detail).toContainText('Another Editor Revised Label');
  await expect(detail).toContainText('Metadata sürümü: 2');
  expect(writes).toHaveLength(1);
  await page.getByRole('button',{name:'Taslak baskıyı düzenle'}).click();
  editor=page.getByTestId('admin-edition-editor');
  await page.getByRole('textbox',{name:'Baskı etiketi'}).fill('Revised Editorial Edition');
  await page.getByRole('textbox',{name:'Yayınevi (boş bırakılırsa temizlenir)'}).fill('');
  await page.getByRole('textbox',{name:'Tanımlayıcı değeri 1'}).fill('9781111111112');
  await page.getByRole('button',{name:'Kaldır Tanımlayıcılar 2'}).click();
  await page.getByRole('combobox',{name:'Görev 1'}).selectOption('editor');
  await editor.getByRole('button',{name:'Sürüm kontrollü kaydet'}).click();
  await expect(detail).toContainText('Metadata sürümü: 3');
  await expect(detail).toContainText('Revised Editorial Edition');
  await expect(detail).toContainText('9781111111112');
  await expect(detail).toContainText('editor '+authorId);
  expect(writes).toHaveLength(2);
  expect(writes[0]?.body.expectedVersion).toBe(1);
  expect(writes[1]?.body).toMatchObject({
    expectedVersion:2,label:'Revised Editorial Edition',publisher:null,
    identifiers:[{kind:'isbn-13',value:'9781111111112'}],
    contributors:[{authorId,role:'editor',sortOrder:0}],
  });
  expect(writes.map(row=>row.csrf)).toEqual(['F'.repeat(43),'F'.repeat(43)]);
  const width=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  expect(width).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'Taslak baskıyı düzenle'}).click();
  editor=page.getByTestId('admin-edition-editor');
  await editor.getByRole('button',{name:'Sürüm kontrollü kaydet'}).click();
  await expect(editor.getByRole('alert')).toContainText('Değiştirilen alan yok');
  expect(writes).toHaveLength(2);
  await page.getByRole('button',{name:'EN',exact:true}).click();
  await expect(editor).toContainText('Edit draft edition');
});

test('HTTPS admin edition revision reviewer is read-only, paginated, bilingual and phone-safe',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const editionId='dc2f8287-0f30-4ef5-8a8e-0556d1c1154d';
  const fromId='f5612fc5-767e-4dc9-86e4-4f636f2f84a1';
  const toId='5bfcad92-5fa8-4acb-b6ac-bb5e6f203e9a';
  const firstBlock='05e3d7bc-d7c3-44a3-b58f-b342714f8304';
  const secondBlock='805f8034-c90e-4dd4-b7c0-9cdeebebd105';
  const summary={added:2,removed:0,text_changed:0,metadata_changed:0,moved:0,unchanged:0};
  const requests:string[]=[];
  const item=(blockId:string,ordinal:number)=>({
    blockId,kind:'added',before:null,
    after:{chapterId:authorId,ordinal,kind:'paragraph',
      textSha256:(ordinal===0?'a':'b').repeat(64),
      includeNormal:true,includeRsvp:true,includeAudio:false},
  });
  await page.route('**/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    requests.push(req.method()+' '+url.pathname);
    if(url.pathname==='/v1/admin/catalog/works'&&req.method()==='GET'){
      await route.fulfill(respond({items:[{id:workId,
        originalTitle:'Semantic Revision',originalLanguage:'tr',
        publicationStatus:'draft'}],nextCursor:null}));
    }else if(url.pathname==='/v1/admin/catalog/works/'+workId&&req.method()==='GET'){
      await route.fulfill(respond({
        work:{id:workId,originalTitle:'Semantic Revision',originalLanguage:'tr',
          firstPublicationYear:null,publicationStatus:'draft',metadataVersion:1},
        authors:[{id:authorId,name:'İpek',role:'author',sortOrder:0}],
        titles:[],editions:[{id:editionId,language:'tr',label:'Draft Edition',
          publisher:null,status:'draft',identifiers:[],contributors:[]}],
      }));
    }else if(url.pathname==='/v1/admin/catalog/works/'+workId+
      '/editions/'+editionId+'/revisions'&&req.method()==='GET'){
      const cursor=url.searchParams.get('cursor');
      expect(url.searchParams.get('limit')).toBe('20');
      expect(cursor===null||cursor===toId).toBe(true);
      expect(req.headers()['authorization']).toBeUndefined();
      expect(req.headers()['x-folio-csrf']).toBeUndefined();
      expect(req.postData()).toBeNull();
      await route.fulfill(respond({
        editionId,items:[cursor===null
          ?{id:toId,parentRevisionId:fromId,language:'tr',status:'draft'}
          :{id:fromId,parentRevisionId:null,language:'tr',status:'draft'}],
        nextCursor:cursor===null?toId:null,isMetadataOnly:true,
      }));
    }else if(url.pathname==='/v1/admin/catalog/works/'+workId+
      '/editions/'+editionId+'/revisions/'+toId+'/diff'&&req.method()==='GET'){
      expect(url.searchParams.get('fromRevisionId')).toBe(fromId);
      expect(url.searchParams.get('limit')).toBe('50');
      expect(req.headers()['authorization']).toBeUndefined();
      expect(req.headers()['x-folio-csrf']).toBeUndefined();
      expect(req.postData()).toBeNull();
      const cursor=url.searchParams.get('cursor');
      expect(cursor===null||cursor===firstBlock).toBe(true);
      await route.fulfill(respond({
        editionId,fromRevisionId:fromId,toRevisionId:toId,
        summary,chapterChanges:[{chapterId:authorId,kind:'added'}],
        items:[cursor===null?item(firstBlock,0):item(secondBlock,1)],
        nextCursor:cursor===null?firstBlock:null,isMetadataOnly:true,
      }));
    }else{
      await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
    }
  });
  await page.goto(root+'/admin/works');
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Semantic');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/Semantic Revision/}).click();
  await page.getByRole('button',{name:'Revizyon farkları'}).click();
  const panel=page.getByTestId('admin-revision-diff');
  await expect(panel).toContainText('Salt okunur SHA-256');
  await panel.getByRole('button',{name:'Revizyonları listele'}).click();
  await expect(panel).toContainText('Liste UUID düzenindedir');
  await panel.getByRole('button',{name:'Yeni olarak seç: '+toId}).click();
  await panel.getByRole('button',{name:'Sonraki revizyon sayfası'}).click();
  await panel.getByRole('button',{name:'Önceki olarak seç: '+fromId}).click();
  await expect(page.getByRole('textbox',{name:'Önceki revizyon UUID'})).toHaveValue(fromId);
  await expect(page.getByRole('textbox',{name:'Yeni revizyon UUID'})).toHaveValue(toId);
  expect(requests.filter(x=>x.endsWith('/revisions'))).toHaveLength(2);
  await panel.getByRole('button',{name:'Metadata farkını getir'}).click();
  await expect(panel).toContainText(firstBlock);
  await expect(panel).toContainText('Eklenen');
  await expect(panel).toContainText('Değişen bölüm sayısı');
  expect(requests.filter(x=>x.includes('/diff'))).toHaveLength(1);
  await panel.getByRole('button',{name:'Sonraki blok sayfası'}).click();
  await expect(panel).toContainText(secondBlock);
  await expect(panel).not.toContainText(firstBlock);
  expect(requests.filter(x=>x.includes('/diff'))).toHaveLength(2);
  await page.getByRole('textbox',{name:'Yeni revizyon UUID'}).fill('invalid');
  await panel.getByRole('button',{name:'Metadata farkını getir'}).click();
  await expect(panel.getByRole('alert')).toContainText('geçerli UUID');
  expect(requests.filter(x=>x.includes('/diff'))).toHaveLength(2);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'EN',exact:true}).click();
  await expect(panel).toContainText('Review revision differences');
  await page.getByRole('button',{name:'Revision differences'}).click();
  await expect(panel).toHaveCount(0);
  expect(requests.every(x=>x.startsWith('GET '))).toBe(true);
});

test('real HTTPS rights:read claim ledger is paginated, read-only and evicts revoked access',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const work='40e07813-487e-411c-a5fd-98859098512b';
  const first='7c2b438c-6ee9-45ad-b817-8ef58ab54c5e';
  const second='2bbdef86-2af8-4666-9b27-3e9d44bfb222';
  const calls:string[]=[];
  let rightsReads=0;
  await page.route('**/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    calls.push(req.method()+' '+url.pathname);
    if(url.pathname==='/v1/admin/catalog/works'&&req.method()==='GET'){
      await route.fulfill(respond({
        items:[{id:work,originalTitle:'Rights Review Fixture',
          originalLanguage:'tr',publicationStatus:'draft'}],nextCursor:null,
      }));
    }else if(url.pathname==='/v1/admin/catalog/works/'+work&&req.method()==='GET'){
      await route.fulfill(respond({
        work:{id:work,originalTitle:'Rights Review Fixture',
          originalLanguage:'tr',firstPublicationYear:null,
          publicationStatus:'draft',metadataVersion:1},
        authors:[{id:first,name:'Şule İpek',role:'author',sortOrder:0}],
        titles:[],editions:[],
      }));
    }else if(url.pathname==='/v1/admin/catalog/works/'+work+'/rights'&&req.method()==='GET'){
      expect(url.searchParams.get('limit')).toBe('20');
      expect(req.headers()['authorization']).toBeUndefined();
      expect(req.headers()['x-folio-csrf']).toBeUndefined();
      expect(req.postData()).toBeNull();
      rightsReads++;
      if(rightsReads===3){
        await route.fulfill(respond({error:{code:'FORBIDDEN'}},403));
      }else if(rightsReads===1){
        expect(url.searchParams.get('cursor')).toBeNull();
        await route.fulfill(respond({
          workId:work,items:[{id:first,editionId:null,revisionId:null,
            reviewStatus:'pending',territories:['TR','GB'],
            claims:{display:true,translation:false,audio:false,sharing:false},
            expiresAt:null}],
          nextCursor:first,isMetadataOnly:true,
        }));
      }else{
        expect(url.searchParams.get('cursor')).toBe(first);
        await route.fulfill(respond({
          workId:work,items:[{id:second,editionId:first,revisionId:second,
            reviewStatus:'withdrawn',territories:['US'],
            claims:{display:false,translation:false,audio:false,sharing:false},
            expiresAt:'2026-10-10T00:00:00.000Z'}],
          nextCursor:null,isMetadataOnly:true,
        }));
      }
    }else{
      await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
    }
  });
  await page.goto(root+'/admin/works');
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Rights');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/Rights Review Fixture/}).click();
  await page.getByRole('button',{name:'Hak kayıtları'}).click();
  const ledger=page.getByTestId('admin-rights-ledger');
  await expect(ledger).toContainText('salt okunur metadata');
  await ledger.getByRole('button',{name:'Hak kayıtlarını getir'}).click();
  await expect(ledger).toContainText(first);
  await expect(ledger).toContainText('Beklemede');
  await expect(ledger).toContainText('TR, GB');
  await expect(ledger).not.toContainText('PRIVATE LEGAL EVIDENCE');
  await ledger.getByRole('button',{name:'Sonraki kayıtlar'}).click();
  await expect(ledger).toContainText(second);
  await expect(ledger).not.toContainText('TR, GB');
  await expect(ledger).toContainText('Geri çekildi');
  await ledger.getByRole('button',{name:'İlk sayfaya dön'}).click();
  await expect(ledger.getByRole('alert')).toContainText('Yönetici rolü');
  await expect(ledger).not.toContainText(second);
  expect(rightsReads).toBe(3);
  expect(calls.every(x=>x.startsWith('GET '))).toBe(true);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'EN',exact:true}).click();
  await expect(ledger).toContainText('Rights and territory claims');
  await page.getByRole('button',{name:'Rights ledger'}).click();
  await expect(ledger).toHaveCount(0);
});


test('MFA-scoped original Folio SVG thumbnail is accessible, theme-aware and never external artwork',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({colorScheme:'light'});
  const title='İstanbul & <Öyküler> "Deneme"';
  const author='Çağrı Yılmaz';
  const methods:string[]=[];
  await page.route('**/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    methods.push(req.method()+' '+url.pathname);
    if(url.pathname==='/v1/admin/catalog/works'&&req.method()==='GET'){
      await route.fulfill(respond({items:[{
        id:workId,originalTitle:title,originalLanguage:'tr',publicationStatus:'draft',
      }],nextCursor:null}));
    }else if(url.pathname==='/v1/admin/catalog/works/'+workId&&req.method()==='GET'){
      await route.fulfill(respond({
        work:{id:workId,originalTitle:title,originalLanguage:'tr',
          firstPublicationYear:null,publicationStatus:'draft',metadataVersion:0},
        authors:[{id:authorId,name:author,role:'author',sortOrder:0}],
        titles:[],editions:[],
      }));
    }else await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
  });
  await page.goto(root+'/admin/works');
  await expect(page.getByTestId('admin-folio-cover-preview')).toHaveCount(0);
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('İstanbul');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/İstanbul/}).click();
  const panel=page.getByTestId('admin-folio-cover-preview');
  await expect(panel).toContainText('kapak önizlemesi');
  const image=panel.getByRole('img');
  await expect(image).toHaveAttribute('alt',title+' — '+author);
  const source=await image.getAttribute('src');
  expect(source).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  const svg=decodeURIComponent(source!.split(',').slice(1).join(','));
  expect(svg).toContain('viewBox="0 0 320 480"');
  expect(svg).toContain('İstanbul &amp; &lt;Öyküler&gt;');
  expect(svg).toContain('Çağrı Yılmaz');
  expect(svg).toContain('fill="#26332B"');
  expect(svg).not.toMatch(/<script|<image|<foreignObject|\s(?:href|src)=/i);
  await expect.poll(async()=>image.evaluate(node=>
    (node as HTMLImageElement).naturalWidth)).toBe(320);
  const metrics=await image.boundingBox();
  expect(metrics?.width).toBeLessThanOrEqual(161);
  expect(metrics?.height).toBeGreaterThan(200);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth))
    .toBeLessThanOrEqual(1);
  await page.emulateMedia({colorScheme:'dark'});
  await expect(page.locator('.folio-admin')).toHaveAttribute('data-paperbound-theme','dark');
  await expect.poll(async()=>image.getAttribute('src')).not.toBe(source);
  const dark=decodeURIComponent((await image.getAttribute('src'))!.split(',').slice(1).join(','));
  expect(dark).toContain('fill="#F0F3EB"');
  await page.context().setOffline(true);
  await expect(panel).toHaveCount(0);
  await page.context().setOffline(false);
  expect(methods.every(row=>row.startsWith('GET '))).toBe(true);
  await page.goto('http://127.0.0.1:4173/admin/works');
  await expect(page.getByTestId('admin-catalog-insecure')).toBeVisible();
  await expect(page.getByTestId('admin-folio-cover-preview')).toHaveCount(0);
});


test('HTTPS draft relation unlink requires two-step review, version reload, MFA CSRF and preserves original author/title',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const alternateId='822ab87e-bb66-4a60-a6fb-6675c1dba21b';
  let version=1,firstConflict=true;
  let titles=[
    {id:authorId,language:'tr',title:'Kanonik Başlık',kind:'original'},
    {id:alternateId,language:'en',title:'Taslak Ek Başlık',kind:'alternate'},
  ];
  let authors=[
    {id:authorId,name:'Asıl Yazar',role:'author',sortOrder:0},
    {id:createdAuthorId,name:'İkinci Yazar',role:'co-author',sortOrder:1},
  ];
  const writes:Array<{method:string;path:string;body:unknown;csrf:string|undefined}>=[];
  await page.route('**/v1/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(path==='/v1/auth/web/csrf'){
      await route.fulfill({status:204,headers:{'x-folio-csrf':'U'.repeat(43)}});
    }else if(path==='/v1/admin/catalog/works'&&req.method()==='GET'){
      await route.fulfill(respond({items:[{
        id:workId,originalTitle:'Kanonik Başlık',
        originalLanguage:'tr',publicationStatus:'draft',
      }],nextCursor:null}));
    }else if(path==='/v1/admin/catalog/works/'+workId&&req.method()==='GET'){
      await route.fulfill(respond({
        work:{id:workId,originalTitle:'Kanonik Başlık',
          originalLanguage:'tr',firstPublicationYear:null,
          publicationStatus:'draft',metadataVersion:version},
        authors,titles,editions:[],
      }));
    }else if(req.method()==='DELETE'&&path.startsWith(
      '/v1/admin/catalog/works/'+workId+'/')){
      const body=req.postDataJSON() as unknown;
      writes.push({method:req.method(),path,body,csrf:req.headers()['x-folio-csrf']});
      expect(req.headers()['authorization']).toBeUndefined();
      expect(req.headers()['x-user-id']).toBeUndefined();
      expect(req.headers()['x-admin-role']).toBeUndefined();
      expect(req.headers()['x-request-id']).toBeUndefined();
      if(firstConflict){
        firstConflict=false;version=2;
        await route.fulfill(respond({error:{code:'CONFLICT'}},409));
      }else if(path.endsWith('/titles/'+alternateId)){
        expect(body).toEqual({expectedVersion:2});
        version=3;titles=titles.filter(row=>row.id!==alternateId);
        await route.fulfill(respond({id:alternateId,workId,metadataVersion:3}));
      }else if(path.endsWith('/authors/'+createdAuthorId)){
        expect(body).toEqual({expectedVersion:3});
        version=4;authors=authors.filter(row=>row.id!==createdAuthorId);
        await route.fulfill(respond({workId,authorId:createdAuthorId,metadataVersion:4}));
      }else await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
    }else await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
  });

  await page.goto(root+'/admin/works');
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Kanonik');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/Kanonik Başlık/}).click();
  let panel=page.getByTestId('admin-work-relations');
  await expect(panel).toContainText('Beklenen metadata sürümü: 1');
  await expect(panel.getByRole('button',{
    name:'Alternatif başlığı kaldır: Kanonik Başlık',
  })).toHaveCount(0);

  await panel.getByRole('button',{name:'Alternatif başlığı kaldır: Taslak Ek Başlık'}).click();
  expect(writes).toHaveLength(0); // no accidental single-click deletion
  await panel.getByRole('button',{name:'İlişkiyi kaldırmayı onayla'}).click();
  await expect(panel.getByRole('alert')).toContainText('Başka bir yönetici');
  expect(writes).toHaveLength(1);
  await expect(panel.getByRole('button',{name:'İlişkiyi kaldırmayı onayla'})).toBeDisabled();
  await panel.getByRole('button',{name:'Güncel eseri yeniden yükle'}).click();
  panel=page.getByTestId('admin-work-relations');
  await expect(panel).toContainText('Beklenen metadata sürümü: 2');
  expect(writes).toHaveLength(1);
  await panel.getByRole('button',{name:'Alternatif başlığı kaldır: Taslak Ek Başlık'}).click();
  await panel.getByRole('button',{name:'İlişkiyi kaldırmayı onayla'}).click();
  panel=page.getByTestId('admin-work-relations');
  await expect(panel).toContainText('Beklenen metadata sürümü: 3');
  await expect(panel.getByRole('button',{name:'Alternatif başlığı kaldır: Taslak Ek Başlık'}))
    .toHaveCount(0);
  await panel.getByRole('button',{name:'Eserden yazar bağını kaldır: İkinci Yazar'}).click();
  await panel.getByRole('button',{name:'İlişkiyi kaldırmayı onayla'}).click();
  panel=page.getByTestId('admin-work-relations');
  await expect(panel).toContainText('Beklenen metadata sürümü: 4');
  await expect(panel.getByRole('button',{name:/Eserden yazar bağını kaldır/})).toHaveCount(0);
  await expect(page.getByTestId('admin-catalog-detail')).toContainText('Asıl Yazar');
  await expect(page.getByTestId('admin-catalog-detail')).toContainText('Kanonik Başlık');
  expect(writes).toHaveLength(3);
  expect(writes.every(row=>row.method==='DELETE'&&
    row.csrf==='U'.repeat(43))).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth))
    .toBeLessThanOrEqual(1);
});

test('HTTPS Paperbound match reviewer requires explicit decision, blocks stale retry and never merges works',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const peer='9d4c3c6a-6045-4c16-8c87-991eb78dce05';
  const reviewId='822ab87e-bb66-4a60-a6fb-6675c1dba21b';
  const reviewsPath='/v1/admin/catalog/works/'+workId+'/match-reviews';
  let version=0,proposed=false,conflict=true,finalStatus='pending';
  const writes:Array<{method:string;body:Record<string,unknown>;csrf:string|undefined}>=[];
  await page.route('**/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/v1/auth/web/csrf'){
      await route.fulfill({status:204,headers:{'x-folio-csrf':'M'.repeat(43)}});
    }else if(path==='/v1/admin/catalog/works'&&request.method()==='GET'){
      await route.fulfill(respond({items:[{
        id:workId,originalTitle:'Taslak Eser',
        originalLanguage:'tr',publicationStatus:'draft',
      }],nextCursor:null}));
    }else if(path==='/v1/admin/catalog/works/'+workId&&request.method()==='GET'){
      await route.fulfill(respond({
        work:{id:workId,originalTitle:'Taslak Eser',originalLanguage:'tr',
          firstPublicationYear:null,publicationStatus:'draft',metadataVersion:0},
        authors:[{id:authorId,name:'Asıl Yazar',role:'author',sortOrder:0}],
        titles:[{id:authorId,language:'tr',title:'Taslak Eser',kind:'original'}],
        editions:[],
      }));
    }else if(path===reviewsPath&&request.method()==='GET'){
      await route.fulfill(respond({items:proposed?[{
        id:reviewId,workId,candidateWorkId:peer,peerWorkId:peer,
        peerTitle:'Karşılaştırılan Taslak',status:finalStatus,
        evidenceKind:'same_title',reviewVersion:version,snapshotCurrent:true,
      }]:[],nextCursor:null}));
    }else if(request.method()==='POST'&&path===reviewsPath){
      const body=request.postDataJSON() as Record<string,unknown>;
      writes.push({method:request.method(),body,csrf:request.headers()['x-folio-csrf']});
      expect(request.headers()['authorization']).toBeUndefined();
      expect(request.headers()['x-user-id']).toBeUndefined();
      expect(body).toEqual({candidateWorkId:peer});
      proposed=true;
      await route.fulfill(respond({
        id:reviewId,workId,candidateWorkId:peer,
        status:'pending',reviewVersion:0,changed:true,
      },201));
    }else if(request.method()==='PATCH'&&path===reviewsPath+'/'+reviewId){
      const body=request.postDataJSON() as Record<string,unknown>;
      writes.push({method:request.method(),body,csrf:request.headers()['x-folio-csrf']});
      expect(body).not.toHaveProperty('autoMerge');
      expect(body).not.toHaveProperty('rightsApproved');
      if(conflict){
        conflict=false;version=1;
        await route.fulfill(respond({error:{code:'CONFLICT'}},409));
      }else{
        expect(body).toMatchObject({expectedVersion:1,decision:'distinct'});
        version=2;finalStatus='distinct';
        await route.fulfill(respond({
          id:reviewId,workId,candidateWorkId:peer,status:'distinct',
          reviewVersion:2,changed:true,
        }));
      }
    }else await route.fulfill(respond({error:{code:'NOT_FOUND'}},404));
  });
  await page.goto(root+'/admin/works');
  await page.getByRole('searchbox',{name:'Yazar veya eser metni'}).fill('Taslak');
  await page.getByRole('button',{name:'Ara',exact:true}).click();
  await page.getByRole('button',{name:/Taslak Eser/}).click();
  await page.getByRole('button',{name:'Eser kimlik incelemeleri'}).click();
  const review=page.getByTestId('admin-work-match-reviews');
  await expect(review).toContainText('Bu eser için henüz inceleme kaydı yok.');
  await review.getByRole('textbox',{name:'Diğer kanonik eser UUID'}).fill(peer);
  await review.getByRole('button',{name:'İnceleme kaydı aç'}).click();
  await expect(review).toContainText('Karşılaştırılan Taslak');
  await expect(review).toContainText('Bekliyor');
  await review.getByRole('button',{name:'Kararı incele: Karşılaştırılan Taslak'}).click();
  await review.getByRole('combobox',{name:'İnceleme kararı'}).selectOption('distinct');
  await review.getByRole('textbox',{name:/Gerekçeli editoryal açıklama/})
    .fill('Bağımsız editörün kanıt karşılaştırması iki ayrı eseri doğruluyor.');
  await review.getByRole('button',{name:'Kararı açıkça kaydet'}).click();
  await expect(review.getByRole('alert')).toContainText('Başka bir yönetici');
  expect(writes).toHaveLength(2);
  await expect(review.getByRole('button',{name:'Kararı açıkça kaydet'})).toBeDisabled();
  await review.getByRole('button',{name:'İncelemeleri sunucudan yenile'}).click();
  await expect(review).toContainText('İnceleme sürümü: 1');
  expect(writes).toHaveLength(2); // stale event never resubmits PATCH
  await review.getByRole('button',{name:'Kararı incele: Karşılaştırılan Taslak'}).click();
  await review.getByRole('combobox',{name:'İnceleme kararı'}).selectOption('distinct');
  await review.getByRole('textbox',{name:/Gerekçeli editoryal açıklama/})
    .fill('Bağımsız editör tarafından ikinci sürüm belgeleri karşılaştırıldı.');
  await review.getByRole('button',{name:'Kararı açıkça kaydet'}).click();
  await expect(review).toContainText('Farklı eser');
  await expect(review.getByRole('button',{name:/Kararı incele/})).toHaveCount(0);
  expect(writes).toHaveLength(3);
  expect(writes.map(row=>row.csrf)).toEqual(Array(3).fill('M'.repeat(43)));
  await expect(page.getByTestId('admin-catalog-detail')).toContainText('Taslak Eser');
  const width=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  expect(width).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'EN',exact:true}).click();
  await expect(review).toContainText('Work identity review');
});
