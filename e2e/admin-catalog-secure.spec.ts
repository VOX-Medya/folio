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
