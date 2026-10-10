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
