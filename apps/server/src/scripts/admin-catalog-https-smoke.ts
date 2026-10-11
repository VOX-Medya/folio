import 'reflect-metadata';
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createServer as createHttpsServer,request as httpsRequest} from 'node:https';
import type {Server as HttpsServer} from 'node:https';
import type {AddressInfo} from 'node:net';
import {request as httpRequest} from 'node:http';
import type {IncomingHttpHeaders} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {NestFactory} from '@nestjs/core';
import type {INestApplication} from '@nestjs/common';
import {SwaggerModule} from '@nestjs/swagger';
import {
  adminCatalogAuthorCreatedSchema,adminCatalogAuthorDetailSchema,
  adminCatalogAuthorPageSchema,adminCatalogWorkCreatedSchema,
  adminCatalogWorkDetailSchema,adminCatalogWorkPageSchema,apiErrorSchema,
  canonicalAuthorMetadataUpdatedSchema,canonicalWorkMetadataUpdatedSchema,
  adminCatalogEditionAppendedSchema,adminCatalogTitleAppendedSchema,
  adminCatalogEditionMetadataUpdatedSchema,
  adminCatalogRevisionDiffSchema,
  adminCatalogRevisionListSchema,adminCatalogRightsLedgerSchema,
  adminContentChapterResponseSchema,
  adminRightsClaimCreatedSchema,adminRightsReviewedSchema,
  adminRightsDecisionResultSchema,adminRightsEvidenceSchema,
  adminCatalogWorkAuthorAppendedSchema,
  adminImportCandidateResultSchema,adminImportCandidatePageSchema,
  publishedBookDetailSchema,publishedReaderTextSchema,publishedCatalogSearchPageSchema,shelfListSchema,
} from '@folio/contracts';
import {
  createCanonicalAuthor,createCanonicalWork,createContentRevision,sha256Text,
  createFolioDb,registerPendingAccount,submitRightsEvidence,
  schema,signInVerifiedAccount,verifyAccountEmail,
  previewPreparedCatalogImport,stagePreparedCatalogImport,LocalStorageAdapter,
} from '@folio/db';
import {ApiExceptionFilter,AppModule,createOpenApiDocument} from '../main.js';

type Wire={status:number;headers:IncomingHttpHeaders;body:string};
function check(value:unknown,message:string):asserts value{
  if(!value)throw Error(message);
}
async function call(secure:boolean,port:number,path:string,
  headers:Record<string,string>={},method='GET',body?:unknown):Promise<Wire>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const wireHeaders={...headers,...(payload===undefined?{}:{
    'content-type':'application/json',
    'content-length':String(Buffer.byteLength(payload)),
  })};
  return new Promise((resolve,reject)=>{
    const req=(secure?httpsRequest:httpRequest)({
      host:'127.0.0.1',port,path,method,headers:wireHeaders,
      ...(secure?{rejectUnauthorized:false}:{}),
      timeout:10000,
    },res=>{
      const chunks:Buffer[]=[];
      res.on('data',(part:Buffer)=>chunks.push(part));
      res.on('end',()=>resolve({
        status:res.statusCode??0,headers:res.headers,
        body:Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error',reject);
    });
    req.on('error',reject);
    req.on('timeout',()=>req.destroy(Error('Admin catalog HTTPS lab timeout')));
    req.end(payload);
  });
}
function post(port:number,path:string,headers:Record<string,string>,body:unknown){
  return call(true,port,path,headers,'POST',body);
}
function patch(port:number,path:string,headers:Record<string,string>,body:unknown){
  return call(true,port,path,headers,'PATCH',body);
}
function remove(port:number,path:string,headers:Record<string,string>,body:unknown){
  return call(true,port,path,headers,'DELETE',body);
}

async function main():Promise<void>{
  const url=process.env.DATABASE_URL;
  if(!url)throw Error('Explicit Folio-only test database required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||
    !['localhost','127.0.0.1'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw Error('Admin catalog smoke must use dedicated loopback folio_test');
  }
  const names=[
    'FOLIO_ADMIN_CATALOG_HTTP_MODE','FOLIO_ADMIN_CATALOG_WRITE_MODE',
    'FOLIO_WEB_AUTH_MODE','FOLIO_PRIVATE_STORAGE_ROOT',
    'FOLIO_WEB_AUTH_ORIGIN','FOLIO_WEB_CSRF_KEY_HEX',
    'FOLIO_PUBLIC_CATALOG_TERRITORY',
  ];
  const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const temp=mkdtempSync(join(tmpdir(),'folio-admin-catalog-'));
  const {db,pool}=createFolioDb(url);
  let httpsApp:INestApplication|undefined,httpApp:INestApplication|undefined;
  let liveProxy:HttpsServer|undefined;
  const password='Synthetic-Catalog-HTTPS-Lab-2026!';
  async function account(){
    const email='catalog-https-'+randomUUID()+'@example.com';
    const created=await registerPendingAccount(db,email,password);
    await verifyAccountEmail(db,created.verificationToken);
    return {...created,email};
  }
  async function mfa(sessionId:string,userId:string):Promise<void>{
    const verifiedAt=new Date();
    await db.insert(schema.adminSessionMfa).values({
      sessionId,userId,method:'totp',verifiedAt,
      expiresAt:new Date(verifiedAt.getTime()+5*60_000),
    });
  }
  try{
    // All grants and factor rows are synthetic and restricted to folio_test.
    // Production has no initial administrator provisioning endpoint.
    const editor=await account(),moderator=await account(),guest=await account(),
      viewer=await account(),reviewerA=await account(),reviewerB=await account(),
      rightsReviewer=await account();
    await db.insert(schema.adminRoleMemberships).values([
      {userId:editor.userId,role:'editor',grantedBy:guest.userId},
      {userId:moderator.userId,role:'moderator',grantedBy:guest.userId},
      {userId:viewer.userId,role:'read-only',grantedBy:guest.userId},
      {userId:reviewerA.userId,role:'editor',grantedBy:guest.userId},
      {userId:reviewerB.userId,role:'editor',grantedBy:guest.userId},
      {userId:rightsReviewer.userId,role:'rights',grantedBy:guest.userId},
    ]);
    const native=await signInVerifiedAccount(db,editor.email,password,'android-lab');
    const web=await signInVerifiedAccount(db,editor.email,password,'web-lab');
    const moderatorSession=await signInVerifiedAccount(db,moderator.email,password,'review-lab');
    const guestSession=await signInVerifiedAccount(db,guest.email,password,'guest-lab');
    const viewerSession=await signInVerifiedAccount(db,viewer.email,password,'viewer-lab');
    const reviewerSessionA=await signInVerifiedAccount(db,reviewerA.email,password,'independent-review-a');
    const reviewerSessionB=await signInVerifiedAccount(db,reviewerB.email,password,'independent-review-b');
    const rightsSession=await signInVerifiedAccount(db,rightsReviewer.email,password,'rights-review-lab');
    await mfa(native.sessionId,editor.userId);
    await mfa(moderatorSession.sessionId,moderator.userId);
    await mfa(viewerSession.sessionId,viewer.userId);
    await mfa(reviewerSessionA.sessionId,reviewerA.userId);
    await mfa(reviewerSessionB.sessionId,reviewerB.userId);
    await mfa(rightsSession.sessionId,rightsReviewer.userId);
    const suffix=randomUUID().slice(0,8);
    const author=await createCanonicalAuthor(db,editor.userId,{
      canonicalName:'Folio Canonical Writer '+suffix,
      aliases:[{name:'Other Signature '+suffix}],
    });
    const first=await createCanonicalWork(db,editor.userId,{
      originalTitle:'Folio Editorial '+suffix+' First',
      originalLanguage:'tr',authors:[{authorId:author.id}],
    });
    const second=await createCanonicalWork(db,editor.userId,{
      originalTitle:'Folio Editorial '+suffix+' Second',
      originalLanguage:'en',authors:[{authorId:author.id}],
    });
    const literal=await createCanonicalWork(db,editor.userId,{
      originalTitle:'Literal % '+suffix,originalLanguage:'tr',
      authors:[{authorId:author.id}],
    });

    const key=join(temp,'key.pem'),cert=join(temp,'cert.pem');
    execFileSync('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes',
      '-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],
      {stdio:'ignore'});
    process.env.FOLIO_ADMIN_CATALOG_HTTP_MODE='off';
    process.env.FOLIO_ADMIN_CATALOG_WRITE_MODE='off';
    httpApp=await NestFactory.create(AppModule,{logger:false});
    httpApp.useGlobalFilters(new ApiExceptionFilter());
    const plain=await httpApp.listen(0,'127.0.0.1');
    const plainAddress=plain.address();
    if(!plainAddress||typeof plainAddress==='string')throw Error('No plain lab port');

    httpsApp=await NestFactory.create(AppModule,{
      logger:false,httpsOptions:{key:readFileSync(key),cert:readFileSync(cert)},
    });
    httpsApp.useGlobalFilters(new ApiExceptionFilter());
    SwaggerModule.setup('openapi',httpsApp,createOpenApiDocument(httpsApp));
    const secure=await httpsApp.listen(0,'127.0.0.1');
    const address=secure.address();
    if(!address||typeof address==='string')throw Error('No HTTPS lab port');
    const port=address.port,root='/v1/admin/catalog';
    const bearer={authorization:'Bearer '+native.sessionToken};
    // A synthetic folioctl-style private source, with real DB provenance.
    // No approved rights or public media state is minted by this fixture.
    const privateVault=join(temp,'private-vault');
    process.env.FOLIO_PRIVATE_STORAGE_ROOT=privateVault;
    const chapterOneText='Synthetic unpublished Folio source '+suffix;
    const chapterTwoText='<script>window.__folioReaderInjected=true;</script> remains literal plaintext';
    const editorialBytes=Buffer.from(chapterOneText+'\n\n'+chapterTwoText,'utf8');
    const editorialSha=createHash('sha256').update(editorialBytes).digest('hex');
    const stagedEditorial=await (await LocalStorageAdapter.create(privateVault)).stage({
      owner:{scope:'catalog',ownerUserId:null},
      source:(async function*(){yield editorialBytes;})(),
      declaredSha256:editorialSha,declaredMime:'text/plain',maxBytes:1024,
    });
    const [editorialAsset]=await db.insert(schema.mediaAssets).values({
      ownerScope:'catalog',ownerUserId:null,storageKey:stagedEditorial.key,
      sha256:editorialSha,sizeBytes:editorialBytes.length,mime:'text/plain',
      status:'pending_verify',
    }).returning();
    check(!!editorialAsset,'Synthetic catalog asset missing');
    // Independent catalog identity: do not modify existing browser fixture
    // works whose expected edition lists are asserted below.
    const privateAuthor=await createCanonicalAuthor(db,editor.userId,{
      canonicalName:'Private Source Author '+suffix,
    });
    const privateWork=await createCanonicalWork(db,editor.userId,{
      originalTitle:'Private Source Proof '+suffix,originalLanguage:'tr',
      authors:[{authorId:privateAuthor.id}],
    });
    const [editorialEdition]=await db.insert(schema.editions).values({
      workId:privateWork.id,language:'tr',label:'Private preview edition',status:'draft',
    }).returning();
    check(!!editorialEdition,'Synthetic edition missing');
    const [editorialProvenance]=await db.insert(schema.sourceProvenance).values({
      sourceName:'Synthetic CI editorial source',
      sourceSnapshot:{mediaAssetId:editorialAsset.id,sourceSha256:editorialSha},
    }).returning();
    check(!!editorialProvenance,'Synthetic source provenance missing');
    const [editorialRevision]=await db.insert(schema.contentRevisions).values({
      editionId:editorialEdition.id,language:'tr',
      rawArtifactKey:'quarantine/catalog/'+stagedEditorial.key+'.blob',
      rawSha256:editorialSha,normalizedSha256:editorialSha,
      parserVersion:'folioctl-plain-text-v1',provenanceId:editorialProvenance.id,
      status:'draft',createdBy:editor.userId,
    }).returning();
    check(!!editorialRevision,'Synthetic revision missing');
    const editorialRoute='/v1/admin/catalog/works/'+privateWork.id+
      '/editions/'+editorialEdition.id+'/revisions/'+editorialRevision.id+'/source';
    const search=root+'/works?q='+encodeURIComponent('Folio Editorial '+suffix)+'&limit=1';
    const off=await call(true,port,search,bearer);
    check(off.status===404&&off.headers['cache-control']==='private, no-store',
      'Default-off metadata API exposed draft works');
    const firstDetailPath=root+'/works/'+first.id;
    const authorDetailPath=root+'/authors/'+author.id;
    check((await call(true,port,firstDetailPath,bearer)).status===404&&
      (await call(true,port,authorDetailPath,bearer)).status===404,
      'Default-off admin catalog exposed relational draft details');
    process.env.FOLIO_ADMIN_CATALOG_HTTP_MODE='true';
    check((await call(true,port,search,bearer)).status===404,
      'Non-contract flag enabled private admin catalog');
    process.env.FOLIO_ADMIN_CATALOG_HTTP_MODE='direct-tls-only';
    const editorialResponse=await call(true,port,editorialRoute,bearer);
    check(editorialResponse.status===200&&
      editorialResponse.headers['cache-control']==='private, no-store'&&
      editorialResponse.headers['x-content-type-options']==='nosniff',
      'Verified MFA editor cannot read protected synthetic Folio source');
    const editorialData=JSON.parse(editorialResponse.body);
    check(editorialData.sourceText===editorialBytes.toString('utf8')&&
      editorialData.sha256===editorialSha&&
      editorialData.sizeBytes===editorialBytes.length&&
      !editorialResponse.body.includes(stagedEditorial.key)&&
      !editorialResponse.body.includes(privateVault),
      'Admin editorial source digest or filesystem secrecy mismatch');
    check((await call(true,port,editorialRoute,{
      authorization:'Bearer '+guestSession.sessionToken,
    })).status===403,'Unprivileged signed-in user opened private source');
    check((await call(true,port,editorialRoute)).status===401,
      'Anonymous requester opened editorial private source');
    check((await call(false,plainAddress.port,editorialRoute,bearer)).status===503,
      'Plain HTTP bypassed protected Folio source endpoint');
    check((await call(true,port,editorialRoute+'?owner='+editor.userId,bearer)).status===400,
      'Client-controlled owner hint accepted on protected source route');
    check((await call(true,port,editorialRoute.replace(privateWork.id,second.id),bearer))
      .status===404,'Different catalog work scope opened same source');
    const editablePath=join(privateVault,'quarantine','catalog',
      stagedEditorial.key+'.blob');
    const mutatedBytes=Buffer.from(editorialBytes);
    mutatedBytes[0]=mutatedBytes[0]!^1;
    writeFileSync(editablePath,mutatedBytes);
    check((await call(true,port,editorialRoute,bearer)).status===503,
      'Same-size disk tampering delivered source content');
    writeFileSync(editablePath,editorialBytes);
    console.log('PRIVATE SOURCE HTTPS PASS: MFA, real Folio DB, non-public 0600 bytes, owner scope, SHA mismatch denial.');
    // #23: one complete publish -> withdraw with real HTTPS, Folio DB and
    // already staged private bytes; all scope grants require a separate MFA reviewer.
    const publicBookPath='/v1/catalog/works/'+privateWork.id;
    check((await call(true,port,publicBookPath)).status===404,
      'An unconfigured public catalog returned private metadata');
    process.env.FOLIO_PUBLIC_CATALOG_TERRITORY='TR';
    check((await call(true,port,publicBookPath)).status===404,
      'Unpublished work metadata leaked to public catalog');
    const readerPath='/v1/catalog/reader/'+editorialRevision.id;
    check((await call(true,port,readerPath)).status===404,
      'Draft revision body exposed to public reader');
    const publicationPath=root+'/works/'+privateWork.id+'/editions/'+editorialEdition.id+
      '/revisions/'+editorialRevision.id+'/publication';
    const publicationCommand=(action:'publish'|'withdraw')=>({
      action,territory:'TR',reason:'Synthetic human-reviewed Folio MVP editorial decision',
    });
    const pubChapterId=randomUUID(),pubChapterTwoId=randomUUID();
    const pubBlockId=randomUUID(),pubBlockTwoId=randomUUID();
    await db.insert(schema.contentChapters).values([
      {revisionId:editorialRevision.id,chapterId:pubChapterId,ordinal:0,heading:'Prepared text'},
      {revisionId:editorialRevision.id,chapterId:pubChapterTwoId,ordinal:1,heading:'Additional plaintext'},
    ]);
    await db.insert(schema.contentBlocks).values([
      {revisionId:editorialRevision.id,chapterId:pubChapterId,blockId:pubBlockId,
        ordinal:0,kind:'paragraph',sourceLocator:{format:'text',path:'synthetic/0'},
        sourceText:chapterOneText,
        textSha256:createHash('sha256').update(chapterOneText).digest('hex'),
        includeNormal:true,includeRsvp:true,includeAudio:true},
      {revisionId:editorialRevision.id,chapterId:pubChapterTwoId,blockId:pubBlockTwoId,
        ordinal:0,kind:'paragraph',sourceLocator:{format:'text',path:'synthetic/1'},
        sourceText:chapterTwoText,
        textSha256:createHash('sha256').update(chapterTwoText).digest('hex'),
        includeNormal:true,includeRsvp:true,includeAudio:true},
    ]);
    check((await post(port,publicationPath,bearer,publicationCommand('publish'))).status===404,
      'Admin write opt-in did not protect publication');
    process.env.FOLIO_ADMIN_CATALOG_WRITE_MODE='direct-tls-only';
    check((await post(port,publicationPath,{},publicationCommand('publish'))).status===401,
      'Anonymous account published a draft');
    check((await post(port,publicationPath,{
      authorization:'Bearer '+guestSession.sessionToken,
    },publicationCommand('publish'))).status===403,
      'Non-admin account published a draft');
    check((await post(port,publicationPath,{
      authorization:'Bearer '+rightsSession.sessionToken,
    },publicationCommand('publish'))).status===403,
      'Rights reviewer bypassed independent catalog editor permission');
    check((await post(port,publicationPath.replace(privateWork.id,randomUUID()),bearer,
      publicationCommand('publish'))).status===404,
      'Cross-work publication was not rejected');
    check((await post(port,publicationPath,bearer,{
      ...publicationCommand('publish'),ownerId:editor.userId,
    })).status===400,'Client-supplied owner hint was accepted');
    check((await call(false,plainAddress.port,publicationPath,bearer,'POST',
      publicationCommand('publish'))).status===503,
      'Plain HTTP published a protected Folio source');
    check((await post(port,publicationPath,bearer,publicationCommand('publish'))).status===409,
      'Unreviewed source rights allowed publication');
    const publicationClaims=[
      {workId:privateWork.id},
      {workId:privateWork.id,editionId:editorialEdition.id},
      {workId:privateWork.id,editionId:editorialEdition.id,revisionId:editorialRevision.id},
    ];
    const publicationRecords=[];
    for(const [index,scope] of publicationClaims.entries()){
      const claim=await submitRightsEvidence(db,editor.userId,{
        ...scope,licenseKind:'synthetic-CI-only',
        evidence:'Synthetic publication approval scope '+index+' with manual CI fixture',
        territories:['TR'],displayAllowed:true,
        translationAllowed:false,audioAllowed:false,sharingAllowed:false,
      });
      publicationRecords.push(claim);
      const approval=await patch(port,
        root+'/works/'+privateWork.id+'/rights/'+claim.id,
        {authorization:'Bearer '+rightsSession.sessionToken},{
          decision:'approved',reason:'Synthetic reviewed Folio CI-only rights evidence',
        });
      check(approval.status===200,
        'Real HTTPS MFA rights reviewer could not approve publication scope');
      if(index!==2){
        check((await post(port,publicationPath,bearer,publicationCommand('publish'))).status===409,
          'Incomplete work/edition/revision rights chain published a draft');
      }
    }
    writeFileSync(editablePath,mutatedBytes);
    check((await post(port,publicationPath,bearer,publicationCommand('publish'))).status===409,
      'Altered same-size private bytes became a verified publication');
    writeFileSync(editablePath,editorialBytes);
    check((await call(true,port,publicBookPath)).status===404,
      'Approved rights alone exposed unpublished draft work');
    const published=await post(port,publicationPath,bearer,publicationCommand('publish'));
    check(published.status===200&&published.headers['cache-control']==='private, no-store',
      'Reviewed synthetic catalog source failed authorized publication');
    const publicBook=await call(true,port,publicBookPath);
    check(publicBook.status===200&&publicBook.headers['cache-control']==='no-store',
      'Published synthetic work unavailable from public HTTPS catalog');
    const publicDetail=publishedBookDetailSchema.parse(JSON.parse(publicBook.body));
    check(publicDetail.id===privateWork.id&&
      publicDetail.title===privateWork.originalTitle&&
      publicDetail.authors.some(author=>author.id===privateAuthor.id&&
        author.name===privateAuthor.canonicalName)&&
      publicDetail.editions.length===1&&
      publicDetail.editions[0]?.id===editorialEdition.id&&
      publicDetail.editions[0]?.revisionId===editorialRevision.id&&
      publicDetail.editions[0]?.audioAvailable===false&&
      !publicBook.body.includes(editorialBytes.toString('utf8'))&&
      !publicBook.body.includes(privateVault)&&
      !publicBook.body.includes(stagedEditorial.key)&&
      !publicBook.body.includes('Synthetic publication approval scope'),
      'Public book response leaked source/rights or mismatched author/edition');
    // #33: one true published plaintext source -> two immutable chapters.
    const readerResponse=await call(true,port,readerPath);
    const readerData=publishedReaderTextSchema.parse(JSON.parse(readerResponse.body));
    check(readerResponse.status===200&&readerResponse.headers['cache-control']==='no-store'&&
      readerData.workId===privateWork.id&&readerData.revisionId===editorialRevision.id&&
      readerData.chapters.length===2&&
      readerData.chapters[0]?.heading==='Prepared text'&&
      readerData.chapters[0]?.blocks[0]?.text===chapterOneText&&
      readerData.chapters[0]?.blocks[0]?.includeRsvp===true&&
      readerData.chapters[1]?.blocks[0]?.text===chapterTwoText&&
      !readerResponse.body.includes(stagedEditorial.key)&&
      !readerResponse.body.includes(privateVault),
      'Published reader leaked source keys or returned unverified chapters');
    check((await call(true,port,readerPath+'?territory=US')).status===400,
      'Reader accepted client-controlled publication territory');
    check((await call(false,plainAddress.port,readerPath,{
      'x-forwarded-proto':'https',
    })).status===503,'Forged TLS proxy could read published chapters');
    // #31: real title/author search and private-user shelf on the published fixture.
    const searchUrl='/v1/catalog/search?q='+encodeURIComponent(privateWork.originalTitle);
    const publishedSearch=await call(true,port,searchUrl);
    check(publishedSearch.status===200&&
      publishedCatalogSearchPageSchema.parse(JSON.parse(publishedSearch.body))
        .items.some(item=>item.id===privateWork.id),
      'Public published work title was not searchable');
    const authorSearch=await call(true,port,
      '/v1/catalog/search?q='+encodeURIComponent(privateAuthor.canonicalName));
    check(authorSearch.status===200&&
      publishedCatalogSearchPageSchema.parse(JSON.parse(authorSearch.body))
        .items.some(item=>item.id===privateWork.id),
      'Public approved author search did not include published work');
    check((await call(true,port,'/v1/catalog/search?q=%25%25%25&limit=500')).status===400,
      'Invalid public search bypassed query boundaries');
    const shelfUrl='/v1/me/shelf';
    const ownShelfUrl=shelfUrl+'/'+privateWork.id;
    const guestBearer={authorization:'Bearer '+guestSession.sessionToken};
    check((await call(true,port,shelfUrl)).status===401,
      'Unauthenticated caller received a personal book shelf');
    const beforeShelf=await call(true,port,shelfUrl,guestBearer);
    check(beforeShelf.status===200&&
      shelfListSchema.parse(JSON.parse(beforeShelf.body)).items.length===0,
      'Unmodified verified account did not start with an empty shelf');
    const saveShelf=await call(true,port,ownShelfUrl,guestBearer,'PUT',{status:'to-read'});
    check(saveShelf.status===200&&JSON.parse(saveShelf.body).saved===true,
      'Verified account could not add approved published book to personal shelf');
    const savedShelf=await call(true,port,shelfUrl,guestBearer);
    const saved=shelfListSchema.parse(JSON.parse(savedShelf.body));
    check(savedShelf.status===200&&saved.items.length===1&&
      saved.items[0]?.id===privateWork.id&&saved.items[0]?.status==='to-read'&&
      saved.items[0]?.revisionId===editorialRevision.id,
      'Owner shelf did not retain exact published work and reader revision');
    check((await call(true,port,shelfUrl,{
      authorization:'Bearer '+reviewerSessionA.sessionToken,
    })).status===200,
      'Second account could not view its own empty shelf');
    const otherShelf=await call(true,port,shelfUrl,{
      authorization:'Bearer '+reviewerSessionA.sessionToken,
    });
    check(shelfListSchema.parse(JSON.parse(otherShelf.body)).items.length===0,
      'Owner shelf content leaked across accounts');
    check((await call(true,port,ownShelfUrl,guestBearer,'PUT',{status:'unverified'})).status===400,
      'Invalid owner shelf status was accepted');
    check((await call(true,port,shelfUrl+'/'+randomUUID(),guestBearer,'PUT',
      {status:'to-read'})).status===404,
      'Nonexistent public work was added to shelf');
    const secondSave=await call(true,port,ownShelfUrl,guestBearer,'PUT',{status:'reading'});
    check(secondSave.status===200&&shelfListSchema.parse(
      JSON.parse((await call(true,port,shelfUrl,guestBearer)).body)
    ).items[0]?.status==='reading','Shelf reading state did not update');
    // The second account may remove only its own row, never another owner's row.
    check((await call(true,port,ownShelfUrl,{
      authorization:'Bearer '+reviewerSessionA.sessionToken,
    },'DELETE')).status===204,'Owner-scoped idempotent removal was not allowed');
    check(shelfListSchema.parse(JSON.parse((await call(true,port,shelfUrl,guestBearer)).body))
      .items.length===1,'Second account removed first account shelf item');
    // #31: One actual Expo Chrome -> same-origin HTTPS -> Nest/PG path.
    // The extra proxy and Expo dev server run only inside this synthetic
    // Folio test fixture. They are never production ingress or persistent.
    let shelfProxy:HttpsServer|undefined;
    const previousShelfOrigin=process.env.FOLIO_WEB_AUTH_ORIGIN;
    const previousShelfMode=process.env.FOLIO_WEB_AUTH_MODE;
    const previousShelfCsrf=process.env.FOLIO_WEB_CSRF_KEY_HEX;
    try{
      shelfProxy=createHttpsServer({key:readFileSync(key),cert:readFileSync(cert)},
        (request,response)=>{
          const api=request.url?.startsWith('/v1/')??false;
          const targetPort=api?port:4174;
          const headers:IncomingHttpHeaders={...request.headers,host:'127.0.0.1:'+targetPort};
          delete headers['x-forwarded-proto'];
          delete headers['x-forwarded-host'];
          delete headers['x-forwarded-for'];
          const upstream=(api?httpsRequest:httpRequest)({
            host:'127.0.0.1',port:targetPort,path:request.url??'/',
            method:request.method,headers,
            ...(api?{rejectUnauthorized:false}:{}),
          },incoming=>{
            response.writeHead(incoming.statusCode??502,incoming.headers);
            incoming.pipe(response);
          });
          upstream.on('error',()=>{
            if(!response.headersSent)response.writeHead(502);
            response.end();
          });
          request.pipe(upstream);
        },
      );
      await new Promise<void>((done,reject)=>{
        shelfProxy!.once('error',reject);
        shelfProxy!.listen(0,'127.0.0.1',()=>done());
      });
      const address=shelfProxy.address() as AddressInfo;
      check(address?.port>0,'Synthetic shelf browser proxy unavailable');
      const shelfOrigin='https://127.0.0.1:'+address.port;
      process.env.FOLIO_WEB_AUTH_MODE='direct-tls-only';
      process.env.FOLIO_WEB_AUTH_ORIGIN=shelfOrigin;
      process.env.FOLIO_WEB_CSRF_KEY_HEX=randomBytes(32).toString('hex');
      await new Promise<void>((done,reject)=>{
        const browser=spawn('pnpm',[
          'exec','playwright','test','--config','playwright.catalog.config.ts',
        ],{
          cwd:resolve(process.cwd(),'../..'),
          env:{...process.env,
            FOLIO_LIVE_SHELF_ORIGIN:shelfOrigin,
            FOLIO_LIVE_SHELF_WORK_ID:privateWork.id,
            FOLIO_LIVE_SHELF_TITLE:privateWork.originalTitle,
            FOLIO_LIVE_SHELF_OWNER_TOKEN:guestSession.sessionToken,
            FOLIO_LIVE_SHELF_OTHER_TOKEN:reviewerSessionA.sessionToken,
          },
          stdio:'inherit',
        });
        browser.once('error',reject);
        browser.once('exit',(code,signal)=>{
          if(code===0)done();
          else reject(Error('Real Expo/HTTPS/Folio shelf browser smoke failed, status='+
            String(code??signal)));
        });
      });
      console.log('PUBLIC SHELF LIVE CHROME PASS: Expo title search, CSRF owner save, isolated shelf and reader route.');
    }finally{
      if(previousShelfOrigin===undefined)delete process.env.FOLIO_WEB_AUTH_ORIGIN;
      else process.env.FOLIO_WEB_AUTH_ORIGIN=previousShelfOrigin;
      if(previousShelfMode===undefined)delete process.env.FOLIO_WEB_AUTH_MODE;
      else process.env.FOLIO_WEB_AUTH_MODE=previousShelfMode;
      if(previousShelfCsrf===undefined)delete process.env.FOLIO_WEB_CSRF_KEY_HEX;
      else process.env.FOLIO_WEB_CSRF_KEY_HEX=previousShelfCsrf;
      if(shelfProxy){
        shelfProxy.closeAllConnections();
        await new Promise<void>(done=>shelfProxy!.close(()=>done()));
      }
    }
    check((await call(true,port,publicBookPath+'?territory=US')).status===400,
      'Browser was allowed to override server-owned rights territory');
    check((await call(false,plainAddress.port,publicBookPath,{
      'x-forwarded-proto':'https',
    })).status===503,'Forged proxy TLS bypassed public book transport');
    process.env.FOLIO_PUBLIC_CATALOG_TERRITORY='US';
    check((await call(true,port,readerPath)).status===404,
      'Reader body was accessible outside approved territory');
    check((await call(true,port,publicBookPath)).status===404,
      'Public work was visible outside approved territory');
    process.env.FOLIO_PUBLIC_CATALOG_TERRITORY='TR';
    const publishedResult=JSON.parse(published.body);
    check(publishedResult.workId===privateWork.id&&
      publishedResult.editionId===editorialEdition.id&&
      publishedResult.revisionId===editorialRevision.id&&
      publishedResult.status==='published'&&
      !published.body.includes(privateVault)&&!published.body.includes(stagedEditorial.key),
      'Publication returned incomplete IDs or leaked private filesystem metadata');
    const publicRow=await pool.query<{
      work_status:string;edition_status:string;revision_status:string;
      asset_status:string;verified_at:Date|null;
    }>(
      'SELECT w.publication_status AS work_status, e.status AS edition_status, '+
      'r.status AS revision_status, m.status AS asset_status, m.verified_at '+
      'FROM works w JOIN editions e ON e.work_id=w.id '+
      'JOIN content_revisions r ON r.edition_id=e.id '+
      'JOIN media_assets m ON m.id=$4::uuid '+
      'WHERE w.id=$1::uuid AND e.id=$2::uuid AND r.id=$3::uuid',
      [privateWork.id,editorialEdition.id,editorialRevision.id,editorialAsset.id],
    );
    check(publicRow.rows.length===1&&
      publicRow.rows[0]?.work_status==='published'&&
      publicRow.rows[0]?.edition_status==='published'&&
      publicRow.rows[0]?.revision_status==='published'&&
      publicRow.rows[0]?.asset_status==='verified'&&
      !!publicRow.rows[0]?.verified_at,
      'Publication was not atomic with private catalog byte verification');
    check((await call(true,port,editorialRoute,bearer)).status===404,
      'Published content was still accessible through draft-source preview');
    check((await post(port,publicationPath,bearer,publicationCommand('publish'))).status===409,
      'A second publication was accepted without editorial review');
    const publicationWithdrawal=await post(port,publicationPath,bearer,publicationCommand('withdraw'));
    check(publicationWithdrawal.status===200&&JSON.parse(publicationWithdrawal.body).status==='withdrawn',
      'Authenticated reviewer could not withdraw a published revision');
    check((await call(true,port,publicBookPath)).status===404,
      'Withdrawn work metadata remained publicly accessible');
    check((await call(true,port,readerPath)).status===404,
      'Withdrawn revision body remained publicly accessible');
    check(publishedCatalogSearchPageSchema.parse(JSON.parse(
      (await call(true,port,searchUrl)).body,
    )).items.length===0,'Withdrawn work appeared in public search');
    check(shelfListSchema.parse(JSON.parse(
      (await call(true,port,shelfUrl,guestBearer)).body,
    )).items.length===0,'Withdrawn work remained on visible private shelf');
    const stateAfter=await pool.query<{work_status:string;edition_status:string;revision_status:string}>(
      'SELECT w.publication_status AS work_status,e.status AS edition_status,r.status AS revision_status '+
      'FROM works w JOIN editions e ON e.work_id=w.id JOIN content_revisions r ON r.edition_id=e.id '+
      'WHERE w.id=$1::uuid AND e.id=$2::uuid AND r.id=$3::uuid',
      [privateWork.id,editorialEdition.id,editorialRevision.id],
    );
    check(stateAfter.rows[0]?.work_status==='withdrawn'&&
      stateAfter.rows[0]?.edition_status==='withdrawn'&&
      stateAfter.rows[0]?.revision_status==='withdrawn'&&
      (await post(port,publicationPath,bearer,publicationCommand('publish'))).status===409,
      'Withdrawn rights/content could be silently republished');
    const publicationAudit=await pool.query<{action:string;actor_id:string;request_id:string}>(
      'SELECT action,actor_id,request_id FROM audit_events '+
      'WHERE entity_id=$1::uuid AND action LIKE $2 ORDER BY created_at',
      [editorialRevision.id,'catalog.publication.%'],
    );
    check(publicationAudit.rows.length===2&&
      publicationAudit.rows[0]?.action==='catalog.publication.publish'&&
      publicationAudit.rows[1]?.action==='catalog.publication.withdraw'&&
      publicationAudit.rows.every(row=>row.actor_id===editor.userId&&!!row.request_id),
      'Publish/withdraw audit did not preserve true editor identity');
    process.env.FOLIO_ADMIN_CATALOG_WRITE_MODE='off';
    console.log('PUBLICATION HTTPS PASS: approved 3-scope rights, private byte SHA/inode, admin MFA, draft->published->withdrawn, 401/403/404/409, audit.');

    const createRoot=root+'/authors';
    const draftAuthor={canonicalName:'Native Writer '+suffix,
      aliases:[{name:'Native Alias '+suffix}],
      externalIds:[{source:'folio_ci',externalId:'native-'+suffix}]};
    check((await post(port,createRoot,bearer,draftAuthor)).status===404,
      'Read-only rollout unexpectedly enabled catalog mutation');
    check((await patch(port,authorDetailPath,bearer,{
      expectedVersion:0,canonicalName:'Not edited',
    })).status===404,
      'Read-only rollout enabled canonical PATCH despite independent write flag');
    process.env.FOLIO_ADMIN_CATALOG_WRITE_MODE='true';
    check((await post(port,createRoot,bearer,draftAuthor)).status===404,
      'Non-contract write flag unexpectedly enabled mutation');
    process.env.FOLIO_ADMIN_CATALOG_WRITE_MODE='direct-tls-only';
    check((await call(false,plainAddress.port,createRoot,{
      ...bearer,'x-forwarded-proto':'https',
    },'POST',draftAuthor)).status===503,
      'Forged proxy TLS enabled admin draft mutation');

    const spoofTls=await call(false,plainAddress.port,search,{
      ...bearer,'x-forwarded-proto':'https',
    });
    check(spoofTls.status===503&&
      spoofTls.headers['cache-control']==='private, no-store',
      'Forged proxy TLS revealed private draft metadata');
    check((await call(false,plainAddress.port,firstDetailPath,{
      ...bearer,'x-forwarded-proto':'https',
    })).status===503,
      'Forged forwarded HTTPS allowed admin relational snapshot');

    const spoof=await call(true,port,search,{
      'x-admin-role':'superadmin','x-user-id':editor.userId,
      'x-request-id':'untrusted',
    });
    check(spoof.status===401&&
      apiErrorSchema.parse(JSON.parse(spoof.body)).error.requestId===
        spoof.headers['x-request-id']&&
      spoof.headers['x-request-id']!=='untrusted',
      'Role or identity header bypassed session verification');
    check((await call(true,port,search,{
      authorization:'Bearer '+guestSession.sessionToken,
      'x-admin-role':'superadmin',
    })).status===403,'Unprivileged real account read draft metadata');
    check((await call(true,port,search,{
      authorization:'Bearer '+moderatorSession.sessionToken,
      'x-admin-role':'editor',
    })).status===403,'Moderator with real device MFA acquired catalog:read');
    check((await call(true,port,search,{
      authorization:'Bearer '+web.sessionToken,
    })).status===403,'Editor password + role bypassed exact-device MFA');
    for(const target of [firstDetailPath,authorDetailPath]){
      const forged=await call(true,port,target,{
        'x-user-id':editor.userId,'x-admin-role':'superadmin',
      });
      check(forged.status===401&&forged.headers['cache-control']==='private, no-store',
        'Forged identity/role read an admin canonical detail');
      for(const denied of [
        {authorization:'Bearer '+guestSession.sessionToken,
          'x-admin-role':'superadmin'},
        {authorization:'Bearer '+moderatorSession.sessionToken,
          'x-admin-role':'editor'},
        {authorization:'Bearer '+web.sessionToken},
      ]){
        const response=await call(true,port,target,denied);
        check(response.status===403&&
          apiErrorSchema.parse(JSON.parse(response.body)).error.code==='FORBIDDEN',
          'Insufficient DB role or device MFA exposed an unpublished detail');
      }
      check((await call(true,port,target,{
        ...bearer,origin:'https://wrong-origin.example',
      })).status===401,'Browser-bearing native token exposed canonical detail');
    }
    for(const bad of [
      {origin:'https://admin.example'},
      {'sec-fetch-site':'same-origin'},
    ]){
      check((await call(true,port,search,{...bearer,...bad})).status===401,
        'Browser Origin metadata allowed native bearer route');
    }

    const response=await call(true,port,search,{
      ...bearer,'x-admin-role':'superadmin','x-user-id':guest.userId,
    });
    check(response.status===200&&
      response.headers['cache-control']==='private, no-store'&&
      !response.headers['set-cookie'],
      'Verified admin read failed, was cacheable or leaked a cookie');
    const page=adminCatalogWorkPageSchema.parse(JSON.parse(response.body));
    check(page.items.length===1&&page.nextCursor&&
      page.items[0]?.publicationStatus==='draft',
      'Canonical draft cursor or status was incorrect');
    const next=await call(true,port,search+'&cursor='+page.nextCursor,bearer);
    check(next.status===200,'Second catalog UUID page was not accepted');
    const page2=adminCatalogWorkPageSchema.parse(JSON.parse(next.body));
    check(page2.items.length===1&&page2.nextCursor===null&&
      new Set([page.items[0]?.id,page2.items[0]?.id]).has(first.id)&&
      new Set([page.items[0]?.id,page2.items[0]?.id]).has(second.id),
      'Bounded canonical cursor repeated/dropped an unpublished work');
    const alias=await call(true,port,
      root+'/works?q='+encodeURIComponent('Other Signature '+suffix),bearer);
    check(alias.status===200&&adminCatalogWorkPageSchema.parse(
      JSON.parse(alias.body)).items.length===3,
      'Search through canonical author alias missed metadata');
    const names=await call(true,port,
      root+'/authors?q='+encodeURIComponent('Other Signature '+suffix),bearer);
    check(names.status===200&&adminCatalogAuthorPageSchema.parse(
      JSON.parse(names.body)).items[0]?.id===author.id,
      'Author alias search could not read authorized metadata');
    // A legitimate read-only administrator can inspect the DRAFT, without
    // catalog:edit, in exactly the same session-scoped permission boundary.
    const detailReadOnly={authorization:'Bearer '+viewerSession.sessionToken};
    const safeAuthor=await call(true,port,authorDetailPath,detailReadOnly);
    check(safeAuthor.status===200&&
      safeAuthor.headers['cache-control']==='private, no-store'&&
      !safeAuthor.headers['set-cookie'],
      'Real MFA read-only role could not fetch author editorial metadata');
    const authorDetails=adminCatalogAuthorDetailSchema.parse(
      JSON.parse(safeAuthor.body));
    check(authorDetails.author.id===author.id&&
      authorDetails.author.canonicalName==='Folio Canonical Writer '+suffix&&
      authorDetails.aliases.length===1&&
      authorDetails.aliases[0]?.name==='Other Signature '+suffix&&
      authorDetails.externalIds.length===0,
      'Author aliases or canonical metadata were inconsistent across snapshot');
    const safeWork=await call(true,port,firstDetailPath,detailReadOnly);
    check(safeWork.status===200&&
      safeWork.headers['cache-control']==='private, no-store'&&
      !safeWork.headers['set-cookie'],
      'MFA read-only role could not fetch unpublished work metadata');
    const firstDetails=adminCatalogWorkDetailSchema.parse(
      JSON.parse(safeWork.body));
    check(firstDetails.work.id===first.id&&
      firstDetails.work.originalLanguage==='tr'&&
      firstDetails.work.publicationStatus==='draft'&&
      firstDetails.authors.length===1&&firstDetails.authors[0]?.id===author.id&&
      firstDetails.titles.length===1&&firstDetails.titles[0]?.kind==='original'&&
      firstDetails.editions.length===0,
      'Canonical work snapshot lost author/title relationships or leaked content');
    const repeated=await call(true,port,firstDetailPath,detailReadOnly);
    check(repeated.status===200&&repeated.body===safeWork.body,
      'Stable canonical work metadata changed without an editorial mutation');
    const leakProbe=JSON.stringify([firstDetails,authorDetails]);
    check(!leakProbe.includes('rawArtifactKey')&&
      !leakProbe.includes('sourceText')&&
      !leakProbe.includes('userAccount')&&
      !leakProbe.includes(editor.email)&&
      !leakProbe.includes(viewerSession.sessionToken),
      'Canonical snapshot returned source text, user data or session secrets');

    for(const target of [
      root+'/works/'+randomUUID(),
      root+'/authors/'+randomUUID(),
    ]){
      const missing=await call(true,port,target,detailReadOnly);
      check(missing.status===404&&
        missing.headers['cache-control']==='private, no-store'&&
        apiErrorSchema.parse(JSON.parse(missing.body)).error.code==='NOT_FOUND',
        'Unknown canonical UUID did not safely return uncached 404');
      check((await call(true,port,target,{
        authorization:'Bearer '+guestSession.sessionToken,
      })).status===403,
        'A guest could infer whether a canonical detail UUID exists');
    }
    for(const target of [
      root+'/works/not-a-uuid',
      root+'/authors/not-a-uuid',
      firstDetailPath+'?role=superadmin',
      authorDetailPath+'?userId='+guest.userId,
    ]){
      const invalid=await call(true,port,target,detailReadOnly);
      check(invalid.status===400&&
        invalid.headers['cache-control']==='private, no-store'&&
        apiErrorSchema.parse(JSON.parse(invalid.body)).error.code==='BAD_REQUEST',
        'Malformed canonical ID or caller-controlled query was accepted');
    }

    const pct=await call(true,port,
      root+'/works?q='+encodeURIComponent('% '+suffix),bearer);
    const percent=adminCatalogWorkPageSchema.parse(JSON.parse(pct.body));
    check(percent.items.length===1&&percent.items[0]?.id===literal.id,
      'Literal percent search unexpectedly became a SQL wildcard');

    // A role with catalog:read cannot silently acquire catalog:edit, even
    // with a real same-device MFA proof.
    const viewerBearer={authorization:'Bearer '+viewerSession.sessionToken};
    check((await call(true,port,search,viewerBearer)).status===200,
      'Read-only administrator could not read canonical metadata');
    const deniedPost=async(headers:Record<string,string>,why:string)=>{
      const answer=await post(port,createRoot,headers,draftAuthor);
      check(answer.status===403&&
        answer.headers['cache-control']==='private, no-store'&&
        apiErrorSchema.parse(JSON.parse(answer.body)).error.code==='FORBIDDEN',
        why);
    };
    await deniedPost(viewerBearer,
      'Read-only role with verified MFA created canonical author');
    await deniedPost({
      authorization:'Bearer '+moderatorSession.sessionToken,
      'x-admin-role':'editor',
    },'Moderator with MFA and forged role created author');
    await deniedPost({
      authorization:'Bearer '+guestSession.sessionToken,
      'x-admin-role':'superadmin',
    },'Unprivileged user with forged superadmin header created author');
    await deniedPost({authorization:'Bearer '+web.sessionToken},
      'Same editor password+role without device MFA wrote draft');
    check((await post(port,createRoot,{
      ...bearer,origin:'https://evil.example',
    },draftAuthor)).status===401,
      'Browser Origin-bearing native POST circumvented cookie boundary');
    check((await post(port,createRoot,{
      ...bearer,'sec-fetch-site':'same-origin',
    },draftAuthor)).status===401,
      'Browser fetch metadata-bearing native POST created author');

    const beforeRejected=await pool.query<{count:number}>(
      'SELECT COUNT(*)::integer AS count FROM authors WHERE canonical_name=$1',
      [draftAuthor.canonicalName],
    );
    check(beforeRejected.rows[0]?.count===0,
      'An unauthorized writer created a record before valid request');
    for(const invalid of [
      {...draftAuthor,userId:guest.userId},
      {...draftAuthor,actorId:guest.userId},
      {...draftAuthor,role:'superadmin'},
      {...draftAuthor,publicationStatus:'published'},
      {canonicalName:'    '},
    ]){
      const bad=await post(port,createRoot,bearer,invalid);
      check(bad.status===400&&
        bad.headers['cache-control']==='private, no-store'&&
        apiErrorSchema.parse(JSON.parse(bad.body)).error.code==='BAD_REQUEST',
        'Admin author body schema accepted forbidden fields');
    }
    check((await post(port,createRoot+'?userId='+guest.userId,
      bearer,draftAuthor)).status===400,
      'Privileged POST accepted caller-controlled actor query');

    const signedNative=await post(port,createRoot,{
      ...bearer,'x-admin-role':'superadmin','x-user-id':guest.userId,
      'x-request-id':'forged-request-id',
    },draftAuthor);
    check(signedNative.status===201&&
      signedNative.headers['cache-control']==='private, no-store'&&
      !signedNative.headers['set-cookie']&&
      signedNative.headers['x-request-id']!=='forged-request-id',
      'Authenticated draft author was not created with server-owned trace');
    const nativeDraftId=adminCatalogAuthorCreatedSchema.parse(
      JSON.parse(signedNative.body)).id;
    const signedAlias=await pool.query<{name:string}>(
      'SELECT name FROM author_aliases WHERE author_id=$1::uuid',[nativeDraftId],
    );
    check(signedAlias.rows[0]?.name==='Native Alias '+suffix,
      'Authorized author metadata aliases were not persisted');
    const nativeAudit=await pool.query<{
      action:string;actor_id:string;request_id:string;entity_id:string;
    }>('SELECT action,actor_id,request_id,entity_id FROM audit_events WHERE entity_id=$1::uuid AND action=$2',
      [nativeDraftId,'author.create']);
    check(nativeAudit.rows.length===1&&
      nativeAudit.rows[0]?.actor_id===editor.userId&&
      nativeAudit.rows[0]?.request_id===signedNative.headers['x-request-id'],
      'Author audit did not bind exactly one trusted editor and server request ID');
    const createdAuthorWire=await call(true,port,root+'/authors/'+nativeDraftId,
      bearer);
    check(createdAuthorWire.status===200,
      'Recently committed canonical author could not be read by verified admin');
    const createdAuthorDetail=adminCatalogAuthorDetailSchema.parse(
      JSON.parse(createdAuthorWire.body));
    check(createdAuthorDetail.author.id===nativeDraftId&&
      createdAuthorDetail.aliases.length===1&&
      createdAuthorDetail.aliases[0]?.name==='Native Alias '+suffix&&
      createdAuthorDetail.externalIds.length===1&&
      createdAuthorDetail.externalIds[0]?.externalId==='native-'+suffix,
      'Canonical author detail snapshot failed to join aliases and external IDs');


    // The external author ID is globally unique by source. A failed second
    // command MUST roll back its author row AND audit in the same transaction.
    const collisionName='Collision Writer '+suffix;
    const collision=await post(port,createRoot,bearer,{
      canonicalName:collisionName,
      externalIds:draftAuthor.externalIds,
    });
    check(collision.status===409&&
      apiErrorSchema.parse(JSON.parse(collision.body)).error.code==='CONFLICT',
      'Duplicate external author key did not receive sanitized conflict');
    const collided=await pool.query<{count:number}>(
      'SELECT COUNT(*)::integer AS count FROM authors WHERE canonical_name=$1',
      [collisionName]);
    check(collided.rows[0]?.count===0,
      'Duplicate external author key committed partial author row');

    const authorPath=root+'/authors/'+nativeDraftId;
    const authorPatchInput={expectedVersion:0,
      canonicalName:'Updated Native Writer '+suffix,
      aliases:[{name:'Updated Alias '+suffix,locale:'tr'}],
      externalIds:[{source:'folio_ci',externalId:'updated-'+suffix}]};
    for(const invalid of [
      {expectedVersion:0},
      {...authorPatchInput,role:'superadmin'},
      {...authorPatchInput,actorId:guest.userId},
      {...authorPatchInput,publicationStatus:'published'},
      {...authorPatchInput,expectedVersion:-1},
      {...authorPatchInput,externalIds:[{source:'folio_ci',externalId:'duplicate'},{
        source:'folio_ci',externalId:'duplicate'}]},
    ]){
      const denied=await patch(port,authorPath,bearer,invalid);
      check(denied.status===400,'Invalid canonical author metadata PATCH was accepted');
    }
    check((await patch(port,authorPath,{
      authorization:'Bearer '+viewerSession.sessionToken,
    },authorPatchInput)).status===403,
      'MFA read-only role gained catalog:edit via PATCH');
    check((await patch(port,authorPath,{
      authorization:'Bearer '+web.sessionToken,
    },authorPatchInput)).status===403,
      'Password and valid admin role bypassed same-device MFA for author PATCH');
    const patchedAuthor=await patch(port,authorPath,{
      ...bearer,'x-user-id':guest.userId,'x-admin-role':'superadmin',
      'x-request-id':'forged-author-update',
    },authorPatchInput);
    check(patchedAuthor.status===200&&
      patchedAuthor.headers['cache-control']==='private, no-store'&&
      patchedAuthor.headers['x-request-id']!=='forged-author-update',
      'Verified catalog author metadata version update unavailable');
    const savedAuthor=canonicalAuthorMetadataUpdatedSchema.parse(
      JSON.parse(patchedAuthor.body));
    check(savedAuthor.id===nativeDraftId&&savedAuthor.metadataVersion===1,
      'Canonical author metadata version did not advance exactly once');
    const afterAuthor=adminCatalogAuthorDetailSchema.parse(JSON.parse(
      (await call(true,port,authorPath,bearer)).body));
    check(afterAuthor.author.metadataVersion===1&&
      afterAuthor.author.canonicalName==='Updated Native Writer '+suffix&&
      afterAuthor.aliases.length===1&&
      afterAuthor.aliases[0]?.name==='Updated Alias '+suffix&&
      afterAuthor.externalIds.length===1&&
      afterAuthor.externalIds[0]?.externalId==='updated-'+suffix,
      'Author metadata patch lost canonical aliases or external IDs');
    const originalAuthorAudit=await pool.query<{
      actor_id:string;request_id:string;
      before_json:{metadataVersion:number;canonicalName:string};
      after_json:{metadataVersion:number;canonicalName:string};
    }>('SELECT actor_id,request_id,before_json,after_json FROM audit_events WHERE entity_id=$1::uuid AND action=$2',
      [nativeDraftId,'author.metadata.update']);
    check(originalAuthorAudit.rows.length===1&&
      originalAuthorAudit.rows[0]?.actor_id===editor.userId&&
      originalAuthorAudit.rows[0]?.request_id===patchedAuthor.headers['x-request-id']&&
      originalAuthorAudit.rows[0]?.before_json?.metadataVersion===0&&
      originalAuthorAudit.rows[0]?.after_json?.metadataVersion===1&&
      originalAuthorAudit.rows[0]?.after_json?.canonicalName==='Updated Native Writer '+suffix,
      'Author patch audit did not preserve trusted actor and before/after');
    // Two editors loaded metadata version 1: FOR UPDATE must serialize writes.
    const authorRaces=await Promise.all([
      patch(port,authorPath,bearer,{expectedVersion:1,
        sortName:'First Writer '+suffix}),
      patch(port,authorPath,bearer,{expectedVersion:1,
        sortName:'Second Writer '+suffix}),
    ]);
    check(authorRaces.map(x=>x.status).sort().join(',')==='200,409',
      'Concurrent canonical author updates lost optimistic conflict');
    const finalAuthor=adminCatalogAuthorDetailSchema.parse(JSON.parse(
      (await call(true,port,authorPath,bearer)).body));
    check(finalAuthor.author.metadataVersion===2,
      'Concurrent author PATCH did not increment metadata version once');

    const workInput={
      originalTitle:'Authorized Draft '+suffix,originalLanguage:'tr',
      authors:[{authorId:nativeDraftId,contribution:'author',sortOrder:0}],
      titles:[{language:'en',title:'Reviewed Translation '+suffix,kind:'translation'}],
      editions:[
        {language:'tr',label:'Original '+suffix,
          identifiers:[{kind:'isbn-13',value:'9780000000001'}]},
        {language:'en',label:'Translation '+suffix,contributors:[
          {authorId:author.id,role:'translator',sortOrder:0},
        ]},
      ],
    };
    for(const invalid of [
      {...workInput,publicationStatus:'published'},
      {...workInput,ownerId:guest.userId},
      {...workInput,content:'MADE UP TEXT'},
      {...workInput,authors:[]},
      {...workInput,authors:[{authorId:nativeDraftId},{authorId:nativeDraftId}]},
      {...workInput,editions:[{language:'en',label:'Wrong',status:'published'}]},
    ]){
      const denied=await post(port,root+'/works',bearer,invalid);
      check(denied.status===400&&
        apiErrorSchema.parse(JSON.parse(denied.body)).error.code==='BAD_REQUEST',
        'Admin work POST accepted unsupported status or relationship');
    }
    const realWork=await post(port,root+'/works',bearer,workInput);
    check(realWork.status===201&&
      realWork.headers['cache-control']==='private, no-store',
      'Verified admin could not create an unpublished work');
    const createdWork=adminCatalogWorkCreatedSchema.parse(JSON.parse(realWork.body));
    check(createdWork.publicationStatus==='draft',
      'Created canonical work became published without rights approval');
    const workRow=await pool.query<{publication_status:string}>(
      'SELECT publication_status FROM works WHERE id=$1::uuid',
      [createdWork.id]);
    const editionRows=await pool.query<{count:number}>(
      'SELECT COUNT(*)::integer AS count FROM editions WHERE work_id=$1::uuid',
      [createdWork.id]);
    const workAudit=await pool.query<{
      actor_id:string;request_id:string;after_json:{status?:string};
    }>('SELECT actor_id,request_id,after_json FROM audit_events WHERE entity_id=$1::uuid AND action=$2',
      [createdWork.id,'work.create']);
    check(workRow.rows[0]?.publication_status==='draft'&&
      editionRows.rows[0]?.count===2&&
      workAudit.rows.length===1&&
      workAudit.rows[0]?.actor_id===editor.userId&&
      workAudit.rows[0]?.request_id===realWork.headers['x-request-id']&&
      workAudit.rows[0]?.after_json?.status==='draft',
      'Work/edition draft and actor+request audit were not committed atomically');
    const made=await call(true,port,root+'/works/'+createdWork.id,bearer);
    check(made.status===200&&
      made.headers['cache-control']==='private, no-store'&&
      !made.headers['set-cookie'],
      'Recently created work draft detail was unavailable or cacheable');
    const madeDetails=adminCatalogWorkDetailSchema.parse(JSON.parse(made.body));
    check(madeDetails.work.id===createdWork.id&&
      madeDetails.work.publicationStatus==='draft'&&
      madeDetails.work.firstPublicationYear===null&&
      madeDetails.authors.length===1&&
      madeDetails.authors[0]?.id===nativeDraftId&&
      madeDetails.titles.map(t=>t.language).join(',')==='en,tr'&&
      madeDetails.editions.map(e=>e.language).join(',')==='en,tr'&&
      madeDetails.editions[0]?.contributors[0]?.authorId===author.id&&
      madeDetails.editions[1]?.identifiers[0]?.value==='9780000000001'&&
      madeDetails.editions.every(e=>e.status==='draft'),
      'Work detail did not reflect ordered author/translation/edition contributor links');
    check(!made.body.includes('createdAt')&&
      !made.body.includes('rawArtifactKey')&&
      !made.body.includes('sourceText')&&
      !made.body.includes('rightsRecords'),
      'HTTP work details leaked internal, source, or rights table fields');

    // Intentionally insert out-of-order work authors, titles, editions,
    // identifiers and contributors to prove the actual HTTP route uses the
    // same deterministic ordering as the internal catalog snapshot.
    const unorderedWork=await post(port,root+'/works',bearer,{
      originalTitle:'Out of order '+suffix,originalLanguage:'tr',
      authors:[
        {authorId:nativeDraftId,contribution:'co-author',sortOrder:9},
        {authorId:author.id,contribution:'author',sortOrder:1},
      ],
      titles:[
        {language:'tr',title:'Zulu '+suffix,kind:'alternate'},
        {language:'en',title:'Alpha '+suffix,kind:'translation'},
      ],
      editions:[
        {language:'tr',label:'Last TR '+suffix,
          identifiers:[{kind:'other',value:'Z'},{kind:'other',value:'A'}],
          contributors:[
            {authorId:nativeDraftId,role:'translator',sortOrder:9},
            {authorId:author.id,role:'author',sortOrder:1},
          ]},
        {language:'en',label:'First EN '+suffix},
      ],
    });
    check(unorderedWork.status===201,
      'Synthetic out-of-order editorial draft could not be created');
    const unorderedId=adminCatalogWorkCreatedSchema.parse(
      JSON.parse(unorderedWork.body)).id;
    const orderedWire=await call(true,port,root+'/works/'+unorderedId,
      {authorization:'Bearer '+viewerSession.sessionToken});
    check(orderedWire.status===200,
      'Read-only MFA administrator cannot inspect a newly drafted work');
    const ordered=adminCatalogWorkDetailSchema.parse(JSON.parse(orderedWire.body));
    check(ordered.authors.map(a=>a.id).join(',')===[author.id,nativeDraftId].join(',')&&
      ordered.titles.map(t=>t.language).join(',')==='en,tr,tr'&&
      ordered.editions.map(e=>e.language).join(',')==='en,tr'&&
      ordered.editions[1]?.identifiers.map(i=>i.value).join(',')==='A,Z'&&
      ordered.editions[1]?.contributors.map(p=>p.authorId).join(',')===
        [author.id,nativeDraftId].join(','),
      'Authenticated metadata snapshot lost canonical stable sort keys');
    const stable=await call(true,port,root+'/works/'+unorderedId,
      {authorization:'Bearer '+viewerSession.sessionToken});
    check(stable.body===orderedWire.body,
      'Repeated real HTTPS canonical detail changed without an editorial update');


    const workPath=root+'/works/'+createdWork.id;
    for(const invalid of [
      {expectedVersion:0},
      {expectedVersion:0,publicationStatus:'published'},
      {expectedVersion:0,rawSourceText:'invented'},
      {expectedVersion:0,actorId:guest.userId,originalTitle:'Forged'},
      {expectedVersion:0,originalTitle:' '},
      {expectedVersion:0,firstPublicationYear:2600},
    ]){
      check((await patch(port,workPath,bearer,invalid)).status===400,
        'Work editor accepted content, status, spoofed actor or empty patch');
    }
    check((await patch(port,workPath,{authorization:'Bearer '+
      viewerSession.sessionToken},{expectedVersion:0,originalTitle:'Denied'})).status===403,
      'Real read-only MFA role overwrote canonical work title');
    const correctedTitle='Corrected Canonical Title '+suffix;
    const patchedWork=await patch(port,workPath,{
      ...bearer,'x-request-id':'forged-work-update',
      'x-admin-role':'superadmin','x-user-id':guest.userId,
    },{expectedVersion:0,originalTitle:correctedTitle,firstPublicationYear:1876});
    check(patchedWork.status===200&&
      patchedWork.headers['cache-control']==='private, no-store'&&
      patchedWork.headers['x-request-id']!=='forged-work-update',
      'MFA editor could not atomically PATCH unpublished canonical title/year');
    const savedWork=canonicalWorkMetadataUpdatedSchema.parse(
      JSON.parse(patchedWork.body));
    check(savedWork.id===createdWork.id&&savedWork.metadataVersion===1&&
      savedWork.publicationStatus==='draft',
      'Draft work optimistic revision or publication status mismatch');
    const revised=adminCatalogWorkDetailSchema.parse(JSON.parse(
      (await call(true,port,workPath,bearer)).body));
    check(revised.work.metadataVersion===1&&
      revised.work.originalTitle===correctedTitle&&
      revised.work.firstPublicationYear===1876&&
      revised.work.publicationStatus==='draft'&&
      revised.titles.filter(t=>t.kind==='original'&&t.language==='tr')
        .every(t=>t.title===correctedTitle)&&
      revised.titles.some(t=>t.language==='en'&&t.kind==='translation')&&
      revised.editions.length===2,
      'Canonical title PATCH corrupted original title, alternate translation or editions');
    const workPatchAudit=await pool.query<{
      actor_id:string;request_id:string;
      before_json:{metadataVersion:number;originalTitle:string};
      after_json:{metadataVersion:number;originalTitle:string;publicationStatus:string};
    }>('SELECT actor_id,request_id,before_json,after_json FROM audit_events WHERE entity_id=$1::uuid AND action=$2',
      [createdWork.id,'work.metadata.update']);
    check(workPatchAudit.rows.length===1&&
      workPatchAudit.rows[0]?.actor_id===editor.userId&&
      workPatchAudit.rows[0]?.request_id===patchedWork.headers['x-request-id']&&
      workPatchAudit.rows[0]?.before_json?.metadataVersion===0&&
      workPatchAudit.rows[0]?.after_json?.metadataVersion===1&&
      workPatchAudit.rows[0]?.after_json?.originalTitle===correctedTitle&&
      workPatchAudit.rows[0]?.after_json?.publicationStatus==='draft',
      'Canonical work metadata before-after audit missing original title or owner');
    const workRaces=await Promise.all([
      patch(port,workPath,bearer,{expectedVersion:1,firstPublicationYear:1877}),
      patch(port,workPath,bearer,{expectedVersion:1,firstPublicationYear:1878}),
    ]);
    check(workRaces.map(x=>x.status).sort().join(',')==='200,409',
      'Concurrent canonical work metadata updates ignored optimistic version');
    const finalWork=adminCatalogWorkDetailSchema.parse(JSON.parse(
      (await call(true,port,workPath,bearer)).body));
    check(finalWork.work.metadataVersion===2&&
      [1877,1878].includes(finalWork.work.firstPublicationYear??0),
      'Work revision after competing requests was incoherent');
    check((await patch(port,workPath+'?publicationStatus=published',bearer,{
      expectedVersion:2,originalTitle:'Query Forgery',
    })).status===400,'Query metadata override bypassed strict PATCH route');

    // Failure AFTER work, author, title and edition insertion must unwind
    // all of them; not merely reject an invalid foreign ID before writing.
    const rolledBackName='Rolled Back '+suffix;
    const invalidContributor=await post(port,root+'/works',bearer,{
      ...workInput,originalTitle:rolledBackName,
      editions:[{language:'en',label:'Bad Contributor',contributors:[
        {authorId:randomUUID(),role:'translator'},
      ]}],
    });
    check(invalidContributor.status===400&&
      invalidContributor.headers['cache-control']==='private, no-store',
      'Contributor foreign-key failure was not converted to sanitized 400');
    const aborted=await pool.query<{count:number}>(
      'SELECT COUNT(*)::integer AS count FROM works WHERE original_title=$1',
      [rolledBackName]);
    check(aborted.rows[0]?.count===0,
      'Aborted composite admin mutation committed partial work');
    const auditSecret=JSON.stringify([...nativeAudit.rows,...workAudit.rows]);
    check(!auditSecret.includes(native.sessionToken)&&
      !auditSecret.includes(password)&&!auditSecret.includes(guest.email),
      'Privileged audit events leaked credentials');

    for(const invalid of [
      root+'/works',
      root+'/works?q=',
      root+'/works?q=valid&limit=51',
      root+'/works?q=valid&limit=01',
      root+'/works?q=valid&cursor=invalid',
      root+'/works?q=valid&userId='+guest.userId,
      root+'/authors?q=valid&role=superadmin',
    ]){
      const bad=await call(true,port,invalid,bearer);
      check(bad.status===400&&bad.headers['cache-control']==='private, no-store'&&
        apiErrorSchema.parse(JSON.parse(bad.body)).error.code==='BAD_REQUEST',
        'Invalid/unauthorized search parameter was accepted or cacheable');
    }

    process.env.FOLIO_WEB_AUTH_MODE='direct-tls-only';
    process.env.FOLIO_WEB_AUTH_ORIGIN='https://127.0.0.1:'+port;
    process.env.FOLIO_WEB_CSRF_KEY_HEX=randomBytes(32).toString('hex');
    const cookie={cookie:'__Host-folio_session='+web.sessionToken,
      origin:process.env.FOLIO_WEB_AUTH_ORIGIN,'sec-fetch-site':'same-origin'};
    check((await call(true,port,search,cookie)).status===403,
      'Web login alone minted admin MFA proof');
    check((await call(true,port,firstDetailPath,cookie)).status===403&&
      (await call(true,port,authorDetailPath,cookie)).status===403,
      'Web editor cookie without same-device MFA exposed canonical drafts');
    await mfa(web.sessionId,editor.userId);
    const browser=await call(true,port,search,cookie);
    check(browser.status===200&&
      adminCatalogWorkPageSchema.parse(JSON.parse(browser.body)).items.length===1,
      'Real direct-TLS HttpOnly Web session could not query MFA-verified metadata');
    const browserWork=await call(true,port,root+'/works/'+createdWork.id,cookie);
    const browserAuthor=await call(true,port,root+'/authors/'+nativeDraftId,cookie);
    check(browserWork.status===200&&browserAuthor.status===200&&
      adminCatalogWorkDetailSchema.parse(JSON.parse(browserWork.body)).work.id===
        createdWork.id&&
      adminCatalogAuthorDetailSchema.parse(JSON.parse(browserAuthor.body)).author.id===
        nativeDraftId,
      'Verified exact-origin cookie + MFA could not fetch canonical detail');

    // #12 real Browser -> same-origin TLS reverse proxy -> Nest direct TLS ->
    // Folio-only PostgreSQL. The proxy NEVER makes a request privileged;
    // all server gates see the real user cookie, Origin and DB MFA state.
    // This is NOT the prior route.fulfill mocked browser suite.
    const liveTitle='Folio Live Browser '+suffix;
    const liveAlternate='Folio Live Alternate '+suffix;
    const livePeerName='Folio Live Coauthor '+suffix;
    const liveEditionLabel='Folio Live Empty Edition '+suffix;
    const livePrimary=await createCanonicalAuthor(db,editor.userId,{
      canonicalName:'Folio Live Primary '+suffix,
    });
    const livePeer=await createCanonicalAuthor(db,editor.userId,{
      canonicalName:livePeerName,
    });
    const liveWork=await createCanonicalWork(db,editor.userId,{
      originalTitle:liveTitle,originalLanguage:'tr',
      authors:[
        {authorId:livePrimary.id,contribution:'author',sortOrder:0},
        {authorId:livePeer.id,contribution:'co-author',sortOrder:1},
      ],
      titles:[{language:'en',title:liveAlternate,kind:'alternate'}],
      editions:[{language:'en',label:liveEditionLabel}],
    });
    const liveEditionRows=await pool.query<{id:string}>(
      'SELECT id FROM editions WHERE work_id=$1::uuid AND label=$2',
      [liveWork.id,liveEditionLabel],
    );
    check(liveEditionRows.rows.length===1,'Isolated live-browser edition missing');
    const liveEditionId=liveEditionRows.rows[0]!.id;
    liveProxy=createHttpsServer(
      {key:readFileSync(key),cert:readFileSync(cert)},
      (request,response)=>{
        const target=request.url?.startsWith('/v1/')?'api':'vite';
        const targetPort=target==='api'?port:4173;
        const headers:IncomingHttpHeaders={...request.headers,
          host:'127.0.0.1:'+targetPort};
        // Untrusted forwarded-* transport metadata cannot change
        // security policy. The true upstream is another direct TLS socket.
        delete headers['x-forwarded-proto'];
        delete headers['x-forwarded-host'];
        delete headers['x-forwarded-for'];
        const upstream=(target==='api'?httpsRequest:httpRequest)({
          host:'127.0.0.1',port:targetPort,
          path:request.url??'/',method:request.method,headers,
          ...(target==='api'?{rejectUnauthorized:false}:{}),
        },incoming=>{
          response.writeHead(incoming.statusCode??502,incoming.headers);
          incoming.pipe(response);
        });
        upstream.on('error',()=>{
          if(!response.headersSent)response.writeHead(502);
          response.end();
        });
        request.pipe(upstream);
      },
    );
    await new Promise<void>((done,reject)=>{
      liveProxy!.once('error',reject);
      liveProxy!.listen(0,'127.0.0.1',()=>done());
    });
    const proxyAddress=liveProxy.address() as AddressInfo;
    check(proxyAddress?.port>0,'No isolated real-browser HTTPS port');
    const originalWebOrigin=process.env.FOLIO_WEB_AUTH_ORIGIN;
    const liveOrigin='https://127.0.0.1:'+proxyAddress.port;
    process.env.FOLIO_WEB_AUTH_ORIGIN=liveOrigin;
    try{
      // Only SYNTHETIC, local folio_test MFA session tokens cross this
      // ephemeral child-process boundary. No token is logged or committed.
      await new Promise<void>((done,reject)=>{
        const processHandle=spawn('pnpm',[
          'exec','playwright','test','--config','playwright.live.config.ts',
        ],{
          cwd:resolve(process.cwd(),'../..'),
          env:{...process.env,
            FOLIO_LIVE_BROWSER_ORIGIN:liveOrigin,
            FOLIO_LIVE_BROWSER_WORK_ID:liveWork.id,
            FOLIO_LIVE_BROWSER_TITLE:liveTitle,
            FOLIO_LIVE_BROWSER_ALTERNATE:liveAlternate,
            FOLIO_LIVE_BROWSER_PEER_NAME:livePeerName,
            FOLIO_LIVE_BROWSER_EDITION_LABEL:liveEditionLabel,
            FOLIO_LIVE_BROWSER_EDITION_ID:liveEditionId,
            FOLIO_LIVE_BROWSER_EDITOR_TOKEN:web.sessionToken,
            FOLIO_LIVE_BROWSER_PEER_TOKEN:reviewerSessionA.sessionToken,
            FOLIO_LIVE_BROWSER_VIEWER_TOKEN:viewerSession.sessionToken,
          },
          stdio:'inherit',
        });
        processHandle.once('error',reject);
        processHandle.once('exit',(exit,signal)=>{
          if(exit===0)done();
          else reject(Error('Real Folio browser/PG/HTTPS test failed, status='+
            String(exit??signal)));
        });
      });
    }finally{
      process.env.FOLIO_WEB_AUTH_ORIGIN=originalWebOrigin;
      liveProxy.closeAllConnections();
      await new Promise<void>(done=>liveProxy!.close(()=>done()));
      liveProxy=undefined;
    }
    // Browser assertions alone are not enough: verify the actual stored
    // PostgreSQL row and actor-bound before/after audit after the browser
    // has exited. All these records remain isolated in folio_test only.
    const finalLive=await pool.query<{
      original_title:string;metadata_version:number;first_publication_year:number|null;
    }>('SELECT original_title,metadata_version,first_publication_year FROM works '+
      'WHERE id=$1::uuid',[liveWork.id]);
    check(finalLive.rows.length===1&&
      finalLive.rows[0]?.original_title===liveTitle+' Updated'&&
      finalLive.rows[0]?.metadata_version===5&&
      finalLive.rows[0]?.first_publication_year===1872,
      'Real-browser DB persistence does not match versioned UI writes');
    const deletedLiveEdition=await pool.query<{id:string}>(
      'SELECT id FROM editions WHERE id=$1::uuid',[liveEditionId]);
    check(deletedLiveEdition.rows.length===0,
      'Real browser edition delete did not persist');
    const liveAudit=await pool.query<{
      action:string;actor_id:string;request_id:string|null;
      before_json:unknown;after_json:unknown;
    }>(
      'SELECT action,actor_id,request_id,before_json,after_json FROM audit_events '+
      'WHERE (entity_type=$1 AND entity_id=$2::uuid) '+
      'OR (entity_type=$3 AND entity_id=$4::uuid)',
      ['work',liveWork.id,'edition',liveEditionId],
    );
    const expectedLive=[
      {action:'work.metadata.update',actor:reviewerA.userId,count:1},
      {action:'work.metadata.update',actor:editor.userId,count:1},
      {action:'work.title.metadata.update',actor:editor.userId,count:1},
      {action:'work.author.metadata.update',actor:editor.userId,count:1},
      {action:'edition.empty_draft.remove',actor:editor.userId,count:1},
    ];
    // Initial DB fixture already has a separate work.create audit. Do not
    // confuse that trusted seed event with the five browser HTTP mutations.
    const browserAuditWrites=liveAudit.rows.filter(row=>[
      'work.metadata.update','work.title.metadata.update',
      'work.author.metadata.update','edition.empty_draft.remove',
    ].includes(row.action));
    check(browserAuditWrites.length===5,
      'Real-browser test wrote unexpected mutation audits or replayed stale 409');
    for(const expected of expectedLive){
      const events=liveAudit.rows.filter(row=>
        row.action===expected.action&&row.actor_id===expected.actor);
      check(events.length===expected.count&&events.every(row=>
        !!row.request_id&&!!row.before_json&&!!row.after_json),
        'Real-browser audit lost original session actor or before/after evidence');
    }
    console.log('LIVE ADMIN BROWSER + REAL NEST HTTPS + POSTGRES PASS: Chrome 390px TR/EN, MFA 2 actors, 401/403/409, zero automatic retry and five correlated audits.');

    const cookieDraft={canonicalName:'Web Writer '+suffix};
    check((await post(port,createRoot,cookie,cookieDraft)).status===403,
      'Web admin POST without CSRF bypassed double-submit boundary');
    check((await post(port,createRoot,{
      ...cookie,'x-folio-csrf':'A'.repeat(43),
    },cookieDraft)).status===403,
      'Forged HMAC-CSRF permitted privileged author write');
    check((await post(port,createRoot,{
      ...cookie,origin:'https://wrong-origin.example',
      'x-folio-csrf':'A'.repeat(43),
    },cookieDraft)).status===403,
      'Cross-origin cookie POST wrote an unpublished author');
    check((await post(port,createRoot,{
      ...cookie,authorization:'Bearer '+native.sessionToken,
    },cookieDraft)).status===401,
      'Bearer + cookie crossover created privileged author');
    const csrfWire=await call(true,port,'/v1/auth/web/csrf',cookie);
    const csrf=csrfWire.headers['x-folio-csrf'];
    check(csrfWire.status===204&&typeof csrf==='string',
      'Real direct-TLS authenticated cookie CSRF bootstrap unavailable');
    const secureCookie={...cookie,'x-folio-csrf':csrf};
    check((await patch(port,workPath,cookie,{
      expectedVersion:2,firstPublicationYear:1880,
    })).status===403,
      'Web cookie without HMAC-CSRF edited protected metadata');
    check((await patch(port,workPath,{
      ...cookie,'x-folio-csrf':'A'.repeat(43),
    },{expectedVersion:2,firstPublicationYear:1880})).status===403,
      'Forged Web CSRF value edited canonical metadata');
    // #12 editorial identity evidence is a two-editor REVIEW, never a merge.
    const matchPath=root+'/works/'+first.id+'/match-reviews';
    const candidate={candidateWorkId:second.id};
    const reviewerBearerA={authorization:'Bearer '+reviewerSessionA.sessionToken};
    const reviewerBearerB={authorization:'Bearer '+reviewerSessionB.sessionToken};
    const readonlyBearer={authorization:'Bearer '+viewerSession.sessionToken};
    check((await post(port,matchPath,cookie,candidate)).status===403,
      'Web identity-review proposal bypassed HMAC-CSRF');
    check((await post(port,matchPath,{
      ...secureCookie,origin:'https://hostile.example',
    },candidate)).status===403,'Cross-origin session proposed a privileged identity review');
    check((await post(port,matchPath,readonlyBearer,candidate)).status===403,
      'Read-only role proposed canonical match adjudication');
    check((await post(port,matchPath,secureCookie,{
      ...candidate,autoMerge:true,
    })).status===400,'Match proposal accepted automatic canonical merge claim');
    check((await post(port,matchPath,secureCookie,{
      candidateWorkId:first.id,
    })).status===400,'Same canonical work compared with itself');
    const matchOpened=await post(port,matchPath,{
      ...secureCookie,'x-admin-role':'superadmin','x-user-id':guest.userId,
      'x-request-id':'forged-review-request',
    },candidate);
    check(matchOpened.status===201&&
      matchOpened.headers['x-request-id']!=='forged-review-request',
      'MFA cookie could not propose a strictly scoped review');
    const openedReview=JSON.parse(matchOpened.body) as {
      id:string;workId:string;candidateWorkId:string;
      reviewVersion:number;status:string;changed:boolean;
    };
    check(openedReview.changed&&openedReview.reviewVersion===0&&
      openedReview.status==='pending'&&
      [openedReview.workId,openedReview.candidateWorkId].includes(first.id)&&
      [openedReview.workId,openedReview.candidateWorkId].includes(second.id),
      'Proposed review omitted immutable canonical pair');
    const reversedProposal=await post(port,root+'/works/'+second.id+'/match-reviews',
      bearer,{candidateWorkId:first.id});
    check(reversedProposal.status===201&&
      JSON.parse(reversedProposal.body).id===openedReview.id&&
      JSON.parse(reversedProposal.body).changed===false,
      'Reversed canonical pair produced another reviewer ticket or audit');
    const reviewerRead=await call(true,port,matchPath,readonlyBearer);
    const reviewPage=JSON.parse(reviewerRead.body) as {
      items:Array<{id:string;status:string;peerWorkId:string;evidenceKind:string;
        snapshotCurrent:boolean;reviewVersion:number}>;
      nextCursor:string|null;
    };
    check(reviewerRead.status===200&&reviewPage.items.length===1&&
      reviewPage.items[0]?.id===openedReview.id&&
      reviewPage.items[0]?.peerWorkId===second.id&&
      reviewPage.items[0]?.evidenceKind==='manual'&&
      reviewPage.items[0]?.snapshotCurrent===true&&
      reviewPage.nextCursor===null,
      'Read-only MFA catalog editor could not inspect bounded, private candidate metadata');
    check((await call(true,port,matchPath+'?userId='+guest.userId,bearer)).status===400,
      'Review list accepted a user selector');
    const reviewDecisionPath=matchPath+'/'+openedReview.id;
    const verdict={expectedVersion:0,decision:'distinct',
      rationale:'Independent editorial check confirms two distinct synthetic canonical works.'};
    check((await patch(port,reviewDecisionPath,bearer,verdict)).status===403,
      'Review proposer was able to approve their own candidate identity');
    check((await patch(port,reviewDecisionPath,readonlyBearer,verdict)).status===403,
      'Read-only MFA role could decide a privileged editorial review');
    check((await patch(port,reviewDecisionPath,reviewerBearerA,{
      ...verdict,decision:'merge',
    })).status===400,'Reviewer could force canonical work merge');
    check((await patch(port,reviewDecisionPath,reviewerBearerA,{
      ...verdict,approveRights:true,
    })).status===400,'Reviewer could smuggle territorial rights approval');
    const adjudications=await Promise.all([
      patch(port,reviewDecisionPath,reviewerBearerA,verdict),
      patch(port,reviewDecisionPath,reviewerBearerB,verdict),
    ]);
    check(adjudications.map(row=>row.status).sort().join(',')==='200,409',
      'Competing independent editors both committed identity review');
    const chosen=adjudications.find(row=>row.status===200)!;
    check(JSON.parse(chosen.body).status==='distinct'&&
      JSON.parse(chosen.body).reviewVersion===1,
      'Independent editorial review status/version was not persisted');
    check((await patch(port,reviewDecisionPath,reviewerBearerA,verdict)).status===409,
      'A repeated verdict created a second decision');
    const persistedRows=await pool.query<{
      status:string;review_version:number;proposed_by:string;reviewed_by:string|null;
    }>('SELECT status,review_version,proposed_by,reviewed_by FROM canonical_work_match_reviews WHERE id=$1::uuid',
      [openedReview.id]);
    const persisted=persistedRows.rows[0];
    check(persisted?.status==='distinct'&&persisted.review_version===1&&
      persisted.proposed_by===editor.userId&&
      [reviewerA.userId,reviewerB.userId].includes(persisted.reviewed_by??'')&&
      persisted.reviewed_by!==persisted.proposed_by,
      'A proposer, impostor, or concurrent second editor overwrote the reviewer');
    const editorialAudits=await pool.query<{
      action:string;actor_id:string;request_id:string;
    }>('SELECT action,actor_id,request_id FROM audit_events WHERE entity_id=$1::uuid AND entity_type=$2 ORDER BY created_at',
      [openedReview.id,'canonical_work_match_review']);
    check(editorialAudits.rows.length===2&&
      editorialAudits.rows.some(row=>row.action==='catalog.work.match_review.proposed'&&
        row.actor_id===editor.userId&&
        row.request_id===matchOpened.headers['x-request-id'])&&
      editorialAudits.rows.some(row=>row.action==='catalog.work.match_review.decided'&&
        [reviewerA.userId,reviewerB.userId].includes(row.actor_id)),
      'Editorial match review was not independently authenticated and audited once');

    // Work metadata changed AFTER proposal: only an explicit re-proposal can
    // bind new evidence; the original decision must not survive silently.
    const changedCandidate=await createCanonicalWork(db,editor.userId,{
      originalTitle:'Stale Match '+suffix,originalLanguage:'tr',
      authors:[{authorId:author.id}],
    });
    const staleReviewPath=root+'/works/'+first.id+'/match-reviews';
    const staleOpened=await post(port,staleReviewPath,bearer,{
      candidateWorkId:changedCandidate.id,
    });
    check(staleOpened.status===201,'Cannot propose future stale metadata fixture');
    const staleReviewId=JSON.parse(staleOpened.body).id as string;
    const updatedCandidate=await patch(port,root+'/works/'+changedCandidate.id,
      reviewerBearerA,{expectedVersion:0,firstPublicationYear:1911});
    check(updatedCandidate.status===200,'Synthetic candidate version could not change');
    check((await patch(port,staleReviewPath+'/'+staleReviewId,reviewerBearerB,{
      expectedVersion:0,decision:'distinct',
      rationale:'Stale candidate metadata was not rechecked before deciding.',
    })).status===409,'Changed work metadata permitted stale review decision');
    const refreshed=await post(port,staleReviewPath,bearer,{
      candidateWorkId:changedCandidate.id,
    });
    check(refreshed.status===201&&JSON.parse(refreshed.body).changed===true&&
      JSON.parse(refreshed.body).reviewVersion===1,
      'Stale review could not be explicitly refreshed for independent adjudication');
    const deferred=await patch(port,staleReviewPath+'/'+staleReviewId,reviewerBearerB,{
      expectedVersion:1,decision:'deferred',
      rationale:'Insufficient independent evidence for matching revised metadata.',
    });
    check(deferred.status===200&&JSON.parse(deferred.body).status==='deferred'&&
      JSON.parse(deferred.body).reviewVersion===2,
      'Refreshed human-review decision was not properly versioned');
    const originalPair=await pool.query<{
      id:string;publication_status:string;metadata_version:number;
    }>('SELECT id,publication_status,metadata_version FROM works WHERE id = ANY($1::uuid[])',
      [[first.id,second.id]]);
    check(originalPair.rows.length===2&&
      originalPair.rows.every(row=>row.publication_status==='draft'&&row.metadata_version===0),
      'Review mutated canonical work metadata or silently published/merged works');
    console.log('CANONICAL WORK MATCH REVIEW PASS: two independent MFA editors, 201/200/400/403/409, reversible-pair idempotency, stale refresh and no canonical merge/publish.');
    // #19: an incoming package's *claimed* source metadata may create an
    // MFA editorial case, NEVER an import approval or canonical work merge.
    const incomingClaimPath=root+'/works/'+first.id+'/import-reviews';
    const packageId=randomUUID(),incomingId=randomUUID();
    const incomingTitle='Folio Editorial '+suffix+' First';
    const manifestChecksum=randomBytes(32).toString('hex');
    const claim={
      packageId,manifestChecksum,incomingWorkId:incomingId,
      incomingTitle,incomingLanguage:'tr' as const,
    };
    const beforeImportReview=await pool.query<{count:number}>(
      'SELECT COUNT(*)::integer AS count FROM import_batches');
    check((await post(port,incomingClaimPath,cookie,claim)).status===403,
      'Missing web CSRF opened incoming import identity review');
    check((await post(port,incomingClaimPath,{
      ...secureCookie,origin:'https://attacker.example',
    },claim)).status===403,
    'Cross-origin cookie forged incoming import candidate review');
    check((await post(port,incomingClaimPath,readonlyBearer,claim)).status===403,
      'Read-only role opened incoming import identity review');
    for(const bad of [
      {...claim,publicationStatus:'published'},
      {...claim,autoMerge:true},
      {...claim,rightsApproved:true},
      {...claim,sourceText:'PRIVATE CONTENT'},
      {...claim,manifestChecksum:'not-a-sha'},
      {...claim,incomingWorkId:first.id},
    ]){
      check((await post(port,incomingClaimPath,secureCookie,bad)).status===400,
        'Untrusted package request granted metadata/rights/merge or invalid SHA');
    }
    check((await post(port,incomingClaimPath,bearer,{
      ...claim,incomingTitle:'Entirely different incoming work',
    })).status===409,'Unmatched claimed title created a misleading candidate case');
    check((await post(port,incomingClaimPath,bearer,{
      ...claim,incomingTitle:'Entirely different incoming work',
      sourceSha256:randomBytes(32).toString('hex'),
    })).status===409,'Unverified nonmatching claimed SHA bypassed evidence inspection');
    const madeClaim=await post(port,incomingClaimPath,{
      ...secureCookie,'x-user-id':guest.userId,
      'x-admin-role':'superadmin','x-request-id':'spoofed-import-review',
    },claim);
    check(madeClaim.status===201&&
      madeClaim.headers['x-request-id']!=='spoofed-import-review',
      'Valid MFA editor could not propose an incoming metadata CLAIM');
    const openedClaim=adminImportCandidateResultSchema.parse(JSON.parse(madeClaim.body));
    check(openedClaim.candidateWorkId===first.id&&
      openedClaim.packageId===packageId&&openedClaim.incomingWorkId===incomingId&&
      openedClaim.status==='pending'&&openedClaim.reviewVersion===0&&
      openedClaim.changed===true&&openedClaim.provenanceVerified===false,
      'Incoming candidate incorrectly represented as package provenance verified');
    const replay=await post(port,incomingClaimPath,bearer,claim);
    check(replay.status===201&&
      adminImportCandidateResultSchema.parse(JSON.parse(replay.body)).id===openedClaim.id&&
      adminImportCandidateResultSchema.parse(JSON.parse(replay.body)).changed===false,
      'Identical package work candidate created duplicate review');
    check((await post(port,incomingClaimPath,bearer,{
      ...claim,manifestChecksum:randomBytes(32).toString('hex'),
    })).status===409,'Reused package UUID with changed manifest checksum was accepted');
    check((await post(port,incomingClaimPath,bearer,{
      ...claim,incomingTitle:incomingTitle+' altered',
    })).status===409,'Previously filed package claim could silently change identity');
    const getClaim=await call(true,port,incomingClaimPath,readonlyBearer);
    check(getClaim.status===200&&
      getClaim.headers['cache-control']==='private, no-store',
      'Read-only MFA catalogue role could not see an unverified claim');
    const claimPage=adminImportCandidatePageSchema.parse(JSON.parse(getClaim.body));
    check(claimPage.items.length===1&&claimPage.items[0]?.id===openedClaim.id&&
      claimPage.items[0]?.status==='pending'&&
      claimPage.items[0]?.evidenceKind==='claimed_title'&&
      claimPage.items[0]?.snapshotCurrent&&claimPage.items[0]?.provenanceVerified===false,
      'Incoming claim pagination leaked bytes or falsified canonical match evidence');
    check(!getClaim.body.includes(manifestChecksum)&&
      !getClaim.body.includes(editor.email)&&
      !getClaim.body.includes(native.sessionToken)&&
      !getClaim.body.includes('sourceSha256')&&
      !getClaim.body.includes('reviewedBy'),
      'Unverified import review leaked manifest digest, reviewer or credentials');
    check((await call(true,port,incomingClaimPath+'?userId='+editor.userId,
      bearer)).status===400,'Incoming review API offered forbidden user search');
    const claimDecisionPath=incomingClaimPath+'/'+openedClaim.id;
    const claimDecision={expectedVersion:0,decision:'distinct',
      rationale:'An independent editor marked the claimed package identity distinct; import remains blocked.'};
    check((await patch(port,claimDecisionPath,bearer,claimDecision)).status===403,
      'Same editor self-approved a claimed import identity');
    check((await patch(port,claimDecisionPath,readonlyBearer,claimDecision)).status===403,
      'Read-only role decided a pending import identity');
    check((await patch(port,claimDecisionPath,reviewerBearerA,{
      ...claimDecision,decision:'merge',
    })).status===400,'Import identity decision accepted automatic merge');
    check((await patch(port,claimDecisionPath,reviewerBearerA,{
      ...claimDecision,rightsApproved:true,
    })).status===400,'Import identity decision approved unreviewed rights');
    const racingDecisions=await Promise.all([
      patch(port,claimDecisionPath,reviewerBearerA,claimDecision),
      patch(port,claimDecisionPath,reviewerBearerB,claimDecision),
    ]);
    check(racingDecisions.map(row=>row.status).sort().join(',')==='200,409'&&
      adminImportCandidateResultSchema.parse(JSON.parse(
        racingDecisions.find(row=>row.status===200)!.body)).reviewVersion===1,
      'Two different MFA editors both committed the same incoming review');
    check((await patch(port,claimDecisionPath,reviewerBearerA,claimDecision)).status===409,
      'Duplicate incoming identity decision produced false-positive audit');
    const storedClaim=await pool.query<{
      status:string;review_version:number;proposed_by:string;reviewed_by:string|null;
    }>('SELECT status,review_version,proposed_by,reviewed_by FROM import_candidate_reviews WHERE id=$1::uuid',
      [openedClaim.id]);
    check(storedClaim.rows[0]?.status==='distinct'&&
      storedClaim.rows[0]?.review_version===1&&
      storedClaim.rows[0]?.proposed_by===editor.userId&&
      [reviewerA.userId,reviewerB.userId].includes(storedClaim.rows[0]?.reviewed_by??''),
      'Untrusted account or double reviewer persisted incoming import decision');
    const importAudits=await pool.query<{action:string;actor_id:string;request_id:string}>(
      'SELECT action,actor_id,request_id FROM audit_events WHERE entity_type=$1 AND entity_id=$2::uuid',
      ['import_candidate_review',openedClaim.id]);
    check(importAudits.rows.length===2&&
      importAudits.rows.some(row=>row.action==='import.candidate.review.proposed'&&
        row.actor_id===editor.userId&&
        row.request_id===madeClaim.headers['x-request-id'])&&
      importAudits.rows.some(row=>row.action==='import.candidate.review.decided'&&
        [reviewerA.userId,reviewerB.userId].includes(row.actor_id)),
      'Incoming package claim created dishonest actor trace or duplicate audit');

    // A human distinct verdict is not evidence of a validated package. The
    // SAME Folio prepared import planner must STILL refuse this collision.
    const preparedClaim={
      packageId,manifestChecksum,schemaVersion:'1.0.0' as const,
      records:{authors:[{
        id:author.id,canonical_name:'Folio Canonical Writer '+suffix,
      }],works:[{id:incomingId,original_title:incomingTitle,
        original_language:'tr' as const,authors:[author.id]}],
      editions:[],revisions:[],rightsRecords:[]},
    };
    const importPreview=await previewPreparedCatalogImport(db,preparedClaim);
    check(!importPreview.canStage&&importPreview.totals.conflict>0,
      'Recorded distinct claim bypassed strict read-only import preview');
    let stagedUnsafe=false;
    try{await stagePreparedCatalogImport(db,editor.userId,preparedClaim);
      stagedUnsafe=true;}catch{/* expected: does NOT write stage */ }
    check(!stagedUnsafe,'Reviewer distinct verdict staged ambiguous source package');
    const afterImportReview=await pool.query<{count:number}>(
      'SELECT COUNT(*)::integer AS count FROM import_batches');
    check(afterImportReview.rows[0]?.count===beforeImportReview.rows[0]?.count,
      'Incoming identity review or rejected import created a staging batch');

    const newerCandidate=await createCanonicalWork(db,editor.userId,{
      originalTitle:'Claimed Stale '+suffix,originalLanguage:'en',
      authors:[{authorId:author.id}],
    });
    const staleClaim={...claim,packageId:randomUUID(),incomingWorkId:randomUUID(),
      incomingTitle:'Claimed Stale '+suffix,incomingLanguage:'en' as const};
    const staleClaimPath=root+'/works/'+newerCandidate.id+'/import-reviews';
    const staleCase=await post(port,staleClaimPath,bearer,staleClaim);
    check(staleCase.status===201,'Fresh claimed identity could not be recorded');
    const staleId=adminImportCandidateResultSchema.parse(JSON.parse(staleCase.body)).id;
    const updated=await patch(port,root+'/works/'+newerCandidate.id,reviewerBearerA,{
      expectedVersion:0,firstPublicationYear:1888,
    });
    check(updated.status===200,'Candidate metadata fixture update failed');
    check((await patch(port,staleClaimPath+'/'+staleId,reviewerBearerB,{
      expectedVersion:0,decision:'deferred',
      rationale:'Changed canonical metadata requires a new independent preview.',
    })).status===409,'Stale canonical metadata accepted a review verdict');
    const reopened=await post(port,staleClaimPath,bearer,staleClaim);
    check(reopened.status===201&&
      adminImportCandidateResultSchema.parse(JSON.parse(reopened.body)).reviewVersion===1,
      'Stale package review could not be explicitly refreshed');
    const final=await patch(port,staleClaimPath+'/'+staleId,reviewerBearerB,{
      expectedVersion:1,decision:'deferred',
      rationale:'Revalidated changed metadata has insufficient independent proof.',
    });
    check(final.status===200&&
      adminImportCandidateResultSchema.parse(JSON.parse(final.body)).reviewVersion===2,
      'Refreshed package review was not safely versioned');
    console.log('INCOMING PACKAGE CLAIM REVIEW PASS: real TLS/Postgres, 201/200/400/403/409, MFA two-person audit, stale version, duplicate/checksum protection; dry-run/stage remain deny.');
    // #12 completed DRAFT metadata matrix: optional title edit, author
    // role/order adjustment, and empty-edition deletion without source/rights.
    const secondary=await createCanonicalAuthor(db,editor.userId,{
      canonicalName:'Secondary '+suffix,
    });
    const relationWork=await createCanonicalWork(db,editor.userId,{
      originalTitle:'Relation completion '+suffix,originalLanguage:'tr',
      authors:[
        {authorId:author.id,contribution:'author',sortOrder:0},
        {authorId:secondary.id,contribution:'co-author',sortOrder:1},
      ],
      titles:[{language:'en',title:'Initial optional title',kind:'alternate'}],
      editions:[
        {language:'en',label:'Empty removable',identifiers:[
          {kind:'isbn-13',value:'9781234567890'},
        ],contributors:[{authorId:secondary.id,role:'translator'}]},
        {language:'tr',label:'Rights protected'},
        {language:'tr',label:'Source protected'},
      ],
    });
    const relationBase=root+'/works/'+relationWork.id;
    const relationDetail=await call(true,port,relationBase,bearer);
    check(relationDetail.status===200,'New DRAFT relation fixture not returned');
    const relationData=adminCatalogWorkDetailSchema.parse(JSON.parse(relationDetail.body));
    const optional=relationData.titles.find(row=>row.kind==='alternate');
    const original=relationData.titles.find(row=>row.kind==='original');
    const empty=relationData.editions.find(row=>row.label==='Empty removable');
    const rightsProtected=relationData.editions.find(row=>row.label==='Rights protected');
    const sourceProtected=relationData.editions.find(row=>row.label==='Source protected');
    check(optional&&original&&empty&&rightsProtected&&sourceProtected,
      'Canonical relation fixture is incomplete');
    const originalTitlePath=relationBase+'/titles/'+original.id;
    const optionalPath=relationBase+'/titles/'+optional.id;
    const mainAuthorPath=relationBase+'/authors/'+author.id;
    const secondaryPath=relationBase+'/authors/'+secondary.id;
    const emptyPath=relationBase+'/editions/'+empty.id;
    const relationRightsPath=relationBase+'/editions/'+rightsProtected.id;
    const sourcePath=relationBase+'/editions/'+sourceProtected.id;
    check((await patch(port,originalTitlePath,bearer,{
      expectedVersion:0,title:'Forbidden original rewriting',
    })).status===409,'Optional editor changed canonical original title');
    check((await patch(port,optionalPath,readonlyBearer,{
      expectedVersion:0,title:'Forbidden role editor',
    })).status===403,'Read-only role edited optional title');
    check((await patch(port,optionalPath,cookie,{
      expectedVersion:0,title:'Forged CSRF',
    })).status===403,'Cookie without current CSRF edited optional title');
    check((await patch(port,optionalPath,{
      ...secureCookie,origin:'https://hostile.example',
    },{expectedVersion:0,title:'Forged origin'})).status===403,
    'Cross-origin cookie edited optional title');
    for(const payload of [
      {expectedVersion:0,kind:'original'},
      {expectedVersion:0,rawSourceText:'rewrite',title:'Forged'},
      {expectedVersion:0,rightsApproved:true,title:'Forged'},
      {expectedVersion:0},
    ]){
      check((await patch(port,optionalPath,bearer,payload)).status===400,
        'Optional title endpoint accepted original/source/rights/empty payload');
    }
    const optionalPatch=await patch(port,optionalPath,bearer,{
      expectedVersion:0,title:'Verified optional edition title',
      language:'en',kind:'translation',
    });
    check(optionalPatch.status===200&&
      adminCatalogTitleAppendedSchema.parse(JSON.parse(optionalPatch.body))
        .metadataVersion===1,
      'Optional title edit did not advance exactly one work version');
    check((await patch(port,secondaryPath,bearer,{
      expectedVersion:0,contribution:'editor',
    })).status===409,'Stale author relation PATCH overwrote newer title edit');
    check((await patch(port,secondaryPath,bearer,{
      expectedVersion:1,contribution:'author',sortOrder:1,
      publish:true,
    })).status===400,'Author link PATCH accepted publish claim');
    const adjusted=await patch(port,secondaryPath,bearer,{
      expectedVersion:1,contribution:'editor',sortOrder:4,
    });
    check(adjusted.status===200&&
      adminCatalogWorkAuthorAppendedSchema.parse(JSON.parse(adjusted.body))
        .metadataVersion===2,'Author role/order update failed');
    check((await patch(port,mainAuthorPath,bearer,{
      expectedVersion:2,contribution:'editor',
    })).status===409,'Last real author was demoted to editor');
    const races=await Promise.all([
      patch(port,mainAuthorPath,bearer,{expectedVersion:2,sortOrder:2}),
      patch(port,optionalPath,bearer,{expectedVersion:2,kind:'alternate'}),
    ]);
    check(races.map(row=>row.status).sort().join(',')==='200,409',
      'Concurrent DRAFT metadata PATCHes both passed a single version gate');

    const [provenance]=await db.insert(schema.sourceProvenance)
      .values({sourceName:'Synthetic protected source '+suffix}).returning();
    check(provenance,'Cannot create protected-source fixture');
    await db.insert(schema.contentRevisions).values({
      editionId:sourceProtected.id,language:'tr',
      rawArtifactKey:'fixture-only/'+suffix,rawSha256:'b'.repeat(64),
      normalizedSha256:'c'.repeat(64),parserVersion:'synthetic-test-only',
      provenanceId:provenance.id,createdBy:editor.userId,
    });
    await db.insert(schema.rightsRecords).values({
      workId:relationWork.id,editionId:rightsProtected.id,
      evidence:'Synthetic rights pending; NEVER publish',
      licenseKind:'unverified',territories:['TR'],
    });
    check((await remove(port,relationRightsPath,bearer,{expectedVersion:3})).status===409,
      'Draft edition with RIGHTS evidence was silently deleted');
    check((await remove(port,sourcePath,bearer,{expectedVersion:3})).status===409,
      'Draft edition with immutable SOURCE REVISION was silently deleted');
    check((await remove(port,emptyPath,readonlyBearer,{expectedVersion:3})).status===403,
      'Read-only role deleted an empty DRAFT edition');
    check((await remove(port,emptyPath,cookie,{expectedVersion:3})).status===403,
      'Missing CSRF deleted an empty DRAFT edition');
    check((await remove(port,emptyPath,bearer,{
      expectedVersion:3,deleteAllRevisions:true,
    })).status===400,'Empty edition removal accepted content deletion flag');
    const removedEdition=await remove(port,emptyPath,bearer,{expectedVersion:3});
    check(removedEdition.status===200&&
      JSON.parse(removedEdition.body).removed===true&&
      JSON.parse(removedEdition.body).metadataVersion===4,
      'Empty DRAFT edition was not removed with a versioned receipt');
    check((await remove(port,emptyPath,bearer,{expectedVersion:4})).status===404,
      'Repeating a completed edition removal did not fail closed');
    check((await remove(port,relationRightsPath,bearer,{expectedVersion:4})).status===409,
      'Rights-protected edition was removable after unrelated update');
    const afterRelations=await call(true,port,relationBase,bearer);
    const finalRelations=adminCatalogWorkDetailSchema.parse(JSON.parse(afterRelations.body));
    check(finalRelations.work.metadataVersion===4&&
      finalRelations.work.originalTitle==='Relation completion '+suffix&&
      finalRelations.titles.some(row=>row.kind==='original'&&row.title===relationWork.originalTitle)&&
      finalRelations.titles.some(row=>row.id===optional.id)&&
      !finalRelations.editions.some(row=>row.id===empty.id)&&
      finalRelations.editions.some(row=>row.id===rightsProtected.id)&&
      finalRelations.editions.some(row=>row.id===sourceProtected.id)&&
      finalRelations.authors.some(row=>row.id===author.id&&row.role==='author')&&
      finalRelations.authors.some(row=>row.id===secondary.id&&row.role==='editor'&&
        row.sortOrder===4),
      'Optional relation CRUD altered original title, last author, or protected editions');
    const relationAudit=await pool.query<{
      action:string;actor_id:string;request_id:string;before_json:unknown;after_json:unknown;
    }>(
      'SELECT action,actor_id,request_id,before_json,after_json FROM audit_events '+ 
      'WHERE (entity_type=$1 AND entity_id=$2::uuid) OR '+
      '(entity_type=$3 AND entity_id=$4::uuid) ORDER BY created_at',
      ['work',relationWork.id,'edition',empty.id],
    );
    const auditExpectations=[
      ['work.title.metadata.update',1+(races[1]?.status===200?1:0)],
      ['work.author.metadata.update',1+(races[0]?.status===200?1:0)],
      ['edition.empty_draft.remove',1],
    ] as const;
    for(const [action,expectedCount] of auditExpectations){
      const events=relationAudit.rows.filter(row=>row.action===action);
      check(events.length===expectedCount&&events.every(row=>
        row.actor_id===editor.userId&&!!row.request_id&&
        !!row.before_json&&!!row.after_json),
        'Incorrect correlated before/after audit count for '+action);
    }
    const protectedRefs=await pool.query<{id:string}>(
      'SELECT id FROM content_revisions WHERE edition_id=$1::uuid',
      [sourceProtected.id],
    );
    check(protectedRefs.rows.length===1,'Edition edit removed immutable content revision');
    console.log('DRAFT RELATION METADATA CRUD PASS: direct TLS/MFA/CSRF, optional title edit, author role/order lock, protected edition refusal, safe empty edition removal, 200/400/403/404/409 and atomic audit.');
    const cookiePatch=await patch(port,workPath,{
      ...secureCookie,'x-request-id':'forged-browser-update',
    },{expectedVersion:2,firstPublicationYear:1880});
    check(cookiePatch.status===200&&
      cookiePatch.headers['x-request-id']!=='forged-browser-update'&&
      canonicalWorkMetadataUpdatedSchema.parse(JSON.parse(cookiePatch.body))
        .metadataVersion===3,
      'Valid same-origin cookie, HMAC-CSRF and same-device MFA could not PATCH draft');
    const patchAudits=await pool.query<{request_id:string;actor_id:string}>(
      'SELECT request_id,actor_id FROM audit_events WHERE entity_id=$1::uuid AND action=$2 ORDER BY created_at DESC',
      [createdWork.id,'work.metadata.update']);
    check(patchAudits.rows.some(row=>
      row.request_id===cookiePatch.headers['x-request-id']&&
      row.actor_id===editor.userId),
      'Cookie-based patch audit did not contain the true editor and server trace');
    const unknownPatch=await patch(port,root+'/works/'+randomUUID(),secureCookie,{
      expectedVersion:0,originalTitle:'Never exist',
    });
    check(unknownPatch.status===404&&
      unknownPatch.headers['cache-control']==='private, no-store',
      'Authorized unknown canonical work patch did not return private 404');

    const cookieCreated=await post(port,createRoot,{
      ...secureCookie,'x-user-id':guest.userId,'x-admin-role':'superadmin',
      'x-request-id':'forged-cookie-trace',
    },cookieDraft);
    check(cookieCreated.status===201&&
      cookieCreated.headers['cache-control']==='private, no-store'&&
      cookieCreated.headers['x-request-id']!=='forged-cookie-trace',
      'Same-origin Cookie + CSRF + MFA could not create an audited author');
    const cookieId=adminCatalogAuthorCreatedSchema.parse(
      JSON.parse(cookieCreated.body)).id;
    const cookieAudit=await pool.query<{
      actor_id:string;request_id:string;
    }>('SELECT actor_id,request_id FROM audit_events WHERE entity_id=$1::uuid AND action=$2',
      [cookieId,'author.create']);
    check(cookieAudit.rows.length===1&&
      cookieAudit.rows[0]?.actor_id===editor.userId&&
      cookieAudit.rows[0]?.request_id===cookieCreated.headers['x-request-id'],
      'CSRF-authorized web mutation did not audit the actual session owner');
    const cookieWork=await post(port,root+'/works',secureCookie,{
      originalTitle:'Web Work '+suffix,originalLanguage:'en',
      authors:[{authorId:cookieId}],
    });
    check(cookieWork.status===201&&
      adminCatalogWorkCreatedSchema.parse(JSON.parse(cookieWork.body))
        .publicationStatus==='draft',
      'Valid Web POST did not create a DRAFT-only canonical work');
    // #12: additional canonical work author/translation metadata and multiple
    // separately identified DRAFT editions, never source/rights/published.
    const linkedWorkId=adminCatalogWorkCreatedSchema.parse(
      JSON.parse(cookieWork.body)).id;
    const editionsPath=root+'/works/'+linkedWorkId+'/editions';
    const titlesPath=root+'/works/'+linkedWorkId+'/titles';
    const authorsPath=root+'/works/'+linkedWorkId+'/authors';
    const linkedEdition={expectedVersion:0,language:'en',
      label:'Folio Translation '+suffix,publisher:'Folio local QA',
      identifiers:[
        {kind:'isbn-13',value:'9780123456789'},
        {kind:'other',value:'folio-local-'+suffix},
      ],
      contributors:[{authorId:author.id,role:'translator',sortOrder:0}],
    };
    const readonlyEditionBearer={authorization:'Bearer '+viewerSession.sessionToken};
    check((await post(port,editionsPath,readonlyEditionBearer,linkedEdition)).status===403,
      'Read-only MFA role created a new edition');
    check((await post(port,editionsPath,cookie,linkedEdition)).status===403,
      'Web cookie without CSRF appended edition');
    check((await post(port,editionsPath,{
      ...secureCookie,origin:'https://untrusted.example',
    },linkedEdition)).status===403,'Cross-origin cookie appended edition');
    for(const bad of [
      {...linkedEdition,publicationStatus:'published'},
      {...linkedEdition,rawContent:'generated text'},
      {...linkedEdition,actorId:guest.userId},
      {...linkedEdition,expectedVersion:-1},
      {...linkedEdition,identifiers:[
        linkedEdition.identifiers[0],linkedEdition.identifiers[0],
      ]},
    ]){
      check((await post(port,editionsPath,secureCookie,bad)).status===400,
        'Untrusted/duplicate canonical edition payload accepted');
    }
    const editionMade=await post(port,editionsPath,{
      ...secureCookie,'x-user-id':guest.userId,'x-admin-role':'superadmin',
      'x-request-id':'forged-edition-trace',
    },linkedEdition);
    check(editionMade.status===201&&
      editionMade.headers['cache-control']==='private, no-store'&&
      editionMade.headers['x-request-id']!=='forged-edition-trace',
      'Verified Web editor could not create a versioned draft edition');
    const createdEdition=adminCatalogEditionAppendedSchema.parse(
      JSON.parse(editionMade.body));
    check(createdEdition.workId===linkedWorkId&&
      createdEdition.metadataVersion===1&&createdEdition.status==='draft',
      'Edition added without incrementing the parent metadata version');
    const editionAudit=await pool.query<{
      actor_id:string;request_id:string;after_json:{
        workId:string;workMetadataVersion:number;status:string;
      };
    }>('SELECT actor_id,request_id,after_json FROM audit_events WHERE entity_id=$1::uuid AND action=$2',
      [createdEdition.id,'edition.create']);
    check(editionAudit.rows.length===1&&
      editionAudit.rows[0]?.actor_id===editor.userId&&
      editionAudit.rows[0]?.request_id===editionMade.headers['x-request-id']&&
      editionAudit.rows[0]?.after_json.workMetadataVersion===1&&
      editionAudit.rows[0]?.after_json.status==='draft',
      'MFA/Cookie/CSRF edition audit lost real actor, trace or DRAFT');
    const badFkLabel='Late Foreign Contributor '+suffix;
    check((await post(port,editionsPath,secureCookie,{
      ...linkedEdition,expectedVersion:1,label:badFkLabel,
      contributors:[{authorId:randomUUID(),role:'translator',sortOrder:0}],
    })).status===400,'Foreign edition contributor did not fail atomically');
    const failedEdition=await pool.query<{count:number}>(
      'SELECT COUNT(*)::integer AS count FROM editions WHERE work_id=$1::uuid AND label=$2',
      [linkedWorkId,badFkLabel]);
    check(failedEdition.rows[0]?.count===0,
      'Late FK failure committed partial edition with invalid contributor');
    check((await post(port,titlesPath,secureCookie,{
      expectedVersion:1,language:'en',title:'Untrusted Original',kind:'original',
    })).status===400,
      'Alternate title endpoint accepted canonical original overwrite');
    check((await post(port,titlesPath,secureCookie,{
      expectedVersion:1,language:'en',title:'Invented Revision',
      kind:'translation',content:'invented text',
    })).status===400,'Title metadata accepted synthetic source text');
    const titleMade=await post(port,titlesPath,secureCookie,{
      expectedVersion:1,language:'tr',title:'Yerel Alternatif '+suffix,
      kind:'alternate',
    });
    check(titleMade.status===201&&
      adminCatalogTitleAppendedSchema.parse(JSON.parse(titleMade.body))
        .metadataVersion===2,
      'Verified editor could not attach translated/alternate title metadata');
    check((await post(port,authorsPath,secureCookie,{
      expectedVersion:2,authorId:randomUUID(),contribution:'co-author',
    })).status===400,'Unknown canonical coauthor was silently inserted');
    const relation=await post(port,authorsPath,secureCookie,{
      expectedVersion:2,authorId:author.id,
      contribution:'co-author',sortOrder:1,
    });
    check(relation.status===201&&
      adminCatalogWorkAuthorAppendedSchema.parse(JSON.parse(relation.body))
        .metadataVersion===3,
      'Canonical work author join did not advance metadata revision');
    check((await post(port,authorsPath,secureCookie,{
      expectedVersion:3,authorId:author.id,contribution:'author',
    })).status===409,'Duplicate work/author PK did not reject duplicate relation');
    // Competing editors must serialize edition children and parent revision.
    const competingEditions=await Promise.all([
      post(port,editionsPath,secureCookie,{
        expectedVersion:3,language:'tr',label:'Race Edition A '+suffix,
      }),
      post(port,editionsPath,secureCookie,{
        expectedVersion:3,language:'en',label:'Race Edition B '+suffix,
      }),
    ]);
    check(competingEditions.map(row=>row.status).sort().join(',')==='201,409',
      'Concurrent edition inserts overwrote canonical work metadata revision');
    const linkedDetailWire=await call(true,port,root+'/works/'+linkedWorkId,bearer);
    const linkedDetail=adminCatalogWorkDetailSchema.parse(JSON.parse(linkedDetailWire.body));
    check(linkedDetail.work.metadataVersion===4&&
      linkedDetail.work.publicationStatus==='draft'&&
      linkedDetail.work.originalTitle==='Web Work '+suffix&&
      linkedDetail.authors.length===2&&
      linkedDetail.editions.length===2&&
      linkedDetail.titles.some(t=>t.title==='Yerel Alternatif '+suffix)&&
      linkedDetail.editions.some(e=>
        e.id===createdEdition.id&&e.status==='draft'&&
        e.identifiers.length===2&&
        e.contributors.some(person=>person.authorId===author.id&&
          person.role==='translator')),
      'Edition/author/translation metadata lost identity or original work linkage');
    const editEditionPath=editionsPath+'/'+createdEdition.id;
    check((await patch(port,editEditionPath,readonlyEditionBearer,{
      expectedVersion:4,label:'Viewer cannot rewrite edition',
    })).status===403,'Read-only MFA editor changed existing canonical edition');
    check((await patch(port,editEditionPath,cookie,{
      expectedVersion:4,label:'No CSRF',
    })).status===403,'Missing Web HMAC-CSRF edited existing edition');
    check((await patch(port,editEditionPath,{
      ...secureCookie,origin:'https://untrusted.example',
    },{expectedVersion:4,label:'Cross origin edition'})).status===403,
      'Cross-origin cookie modified canonical edition');
    check((await patch(port,editionsPath+'/'+randomUUID(),secureCookie,{
      expectedVersion:4,label:'Unknown edition',
    })).status===404,'Authorized unknown edition ID was not 404');
    for(const invalid of [
      {expectedVersion:4},
      {expectedVersion:4,status:'published',label:'Publish illegally'},
      {expectedVersion:4,originalLanguage:'fr',label:'Illegal language change'},
      {expectedVersion:4,rawContent:'Invented material'},
      {expectedVersion:4,actorId:guest.userId,publisher:null},
      {expectedVersion:4,identifiers:[{kind:'other',value:'duplicate'},
        {kind:'other',value:'duplicate'}]},
      {expectedVersion:4,contributors:[{authorId:author.id,role:'translator'},
        {authorId:author.id,role:'translator'}]},
      {expectedVersion:-1,label:'Invalid version'},
    ]){
      check((await patch(port,editEditionPath,secureCookie,invalid)).status===400,
        'Unexpected or duplicate edition metadata edit passed strict validation');
    }
    const revisedEdition=await patch(port,editEditionPath,{
      ...secureCookie,'x-user-id':guest.userId,
      'x-request-id':'forged-edition-edit-trace',
    },{
      expectedVersion:4,label:'Revised Translation '+suffix,publisher:'Updated imprint',
      identifiers:[{kind:'other',value:'new-source-'+suffix}],
      contributors:[{authorId:author.id,role:'editor',sortOrder:2}],
    });
    check(revisedEdition.status===200&&
      revisedEdition.headers['cache-control']==='private, no-store'&&
      revisedEdition.headers['x-request-id']!=='forged-edition-edit-trace'&&
      adminCatalogEditionMetadataUpdatedSchema.parse(JSON.parse(revisedEdition.body))
        .metadataVersion===5,
      'Verified HMAC-CSRF same-device MFA edition PATCH did not commit version 5');
    const editionUpdateAudit=await pool.query<{
      actor_id:string;request_id:string;
      before_json:{workMetadataVersion:number;label:string;identifiers:unknown[]};
      after_json:{workMetadataVersion:number;label:string;identifiers:unknown[]};
    }>('SELECT actor_id,request_id,before_json,after_json FROM audit_events WHERE entity_id=$1::uuid AND action=$2 ORDER BY created_at DESC',
      [createdEdition.id,'edition.metadata.update']);
    check(editionUpdateAudit.rows.length===1&&
      editionUpdateAudit.rows[0]?.actor_id===editor.userId&&
      editionUpdateAudit.rows[0]?.request_id===revisedEdition.headers['x-request-id']&&
      editionUpdateAudit.rows[0]?.before_json.workMetadataVersion===4&&
      editionUpdateAudit.rows[0]?.after_json.workMetadataVersion===5&&
      editionUpdateAudit.rows[0]?.before_json.identifiers.length===2&&
      editionUpdateAudit.rows[0]?.after_json.identifiers.length===1,
      'Canonical edition PATCH audit did not commit trusted actor/request and before/after');
    const badContributorLabel='Should rollback edition '+suffix;
    check((await patch(port,editEditionPath,secureCookie,{
      expectedVersion:5,label:badContributorLabel,
      contributors:[{authorId:randomUUID(),role:'translator',sortOrder:1}],
    })).status===400,'Late edition contributor FK violation did not return 400');
    const rolledEdition=await pool.query<{
      label:string;publisher:string|null;
    }>('SELECT label,publisher FROM editions WHERE id=$1::uuid',
      [createdEdition.id]);
    check(rolledEdition.rows[0]?.label==='Revised Translation '+suffix&&
      rolledEdition.rows[0]?.publisher==='Updated imprint',
      'Late FK failure committed a partial edition metadata edit');
    const competingEditionEdits=await Promise.all([
      patch(port,editEditionPath,secureCookie,{
        expectedVersion:5,label:'Writer A '+suffix,
      }),
      patch(port,editEditionPath,secureCookie,{
        expectedVersion:5,label:'Writer B '+suffix,
      }),
    ]);
    check(competingEditionEdits.map(row=>row.status).sort().join(',')==='200,409',
      'Concurrent edition metadata updates lost optimistic lock');
    const freshEditionDetails=adminCatalogWorkDetailSchema.parse(JSON.parse(
      (await call(true,port,root+'/works/'+linkedWorkId,bearer)).body));
    const freshEdited=freshEditionDetails.editions.find(item=>item.id===createdEdition.id);
    check(freshEditionDetails.work.metadataVersion===6&&
      freshEdited?.language==='en'&&freshEdited.status==='draft'&&
      freshEdited.publisher==='Updated imprint'&&
      ['Writer A '+suffix,'Writer B '+suffix].includes(freshEdited.label)&&
      freshEdited.identifiers.length===1&&
      freshEdited.identifiers[0]?.value==='new-source-'+suffix&&
      freshEdited.contributors.length===1&&
      freshEdited.contributors[0]?.role==='editor',
      'Concurrent edition editing lost ISBN/contributor or changed immutable language');
    check((await patch(port,editEditionPath,secureCookie,{
      expectedVersion:4,label:'Stale edition retry',
    })).status===409,'Stale edition metadata request was accepted');
    const clearPublisher=await patch(port,editEditionPath,secureCookie,{
      expectedVersion:6,publisher:null,
    });
    check(clearPublisher.status===200&&
      adminCatalogEditionMetadataUpdatedSchema.parse(JSON.parse(clearPublisher.body))
        .metadataVersion===7,
      'Explicit nullable publisher edition metadata PATCH failed');
    const clearedDetails=adminCatalogWorkDetailSchema.parse(JSON.parse(
      (await call(true,port,root+'/works/'+linkedWorkId,bearer)).body));
    const cleared=clearedDetails.editions.find(item=>item.id===createdEdition.id);
    check(clearedDetails.work.metadataVersion===7&&
      cleared?.publisher===null&&cleared.identifiers.length===1&&
      cleared.contributors.length===1&&cleared.language==='en',
      'Clearing publisher unexpectedly reset unrelated edition metadata');
    // #12: Removing mistaken OPTIONAL relations cannot orphan canonical
    // authors, delete original titles, bypass MFA/CSRF or stale version locks.
    const removeOptionalTitle=titlesPath+'/'+
      adminCatalogTitleAppendedSchema.parse(JSON.parse(titleMade.body)).id;
    const originalTitleId=linkedDetail.titles.find(t=>t.kind==='original')?.id;
    check(!!originalTitleId,'Synthetic canonical original title missing');
    const removeAuthorPath=authorsPath+'/'+author.id;
    const removePrimaryPath=authorsPath+'/'+cookieId;
    check((await remove(port,removeOptionalTitle,cookie,{
      expectedVersion:7,
    })).status===403,'Unprotected Web cookie unlinked a title without HMAC-CSRF');
    check((await remove(port,removeAuthorPath,readonlyEditionBearer,{
      expectedVersion:7,
    })).status===403,'Read-only MFA role unlinked a canonical author');
    check((await remove(port,removeOptionalTitle,{
      ...secureCookie,origin:'https://foreign.example',
    },{expectedVersion:7})).status===403,
    'Cross-origin cookie unlinked a canonical title');
    check((await remove(port,titlesPath+'/'+originalTitleId,secureCookie,{
      expectedVersion:7,
    })).status===409,'Canonical original title could be removed');
    check((await remove(port,titlesPath+'/'+randomUUID(),secureCookie,{
      expectedVersion:7,
    })).status===404,'Nonexistent optional title did not return authorized 404');
    check((await remove(port,removeOptionalTitle,secureCookie,{
      expectedVersion:7,publicationStatus:'published',
    })).status===400,'Relation unlink accepted publication/rights escalation');
    check((await remove(port,removeOptionalTitle,secureCookie,{
      expectedVersion:6,
    })).status===409,'Stale optional title unlink skipped optimistic version');
    const removedTitle=await remove(port,removeOptionalTitle,{
      ...secureCookie,'x-user-id':guest.userId,
      'x-request-id':'forged-unlink-trace','x-admin-role':'superadmin',
    },{expectedVersion:7});
    check(removedTitle.status===200&&
      removedTitle.headers['cache-control']==='private, no-store'&&
      removedTitle.headers['x-request-id']!=='forged-unlink-trace'&&
      adminCatalogTitleAppendedSchema.parse(JSON.parse(removedTitle.body))
        .metadataVersion===8,
      'Versioned optional title unlink did not authorize/audit exactly once');
    const duplicateTitle=await remove(port,removeOptionalTitle,secureCookie,{
      expectedVersion:8,
    });
    check(duplicateTitle.status===404,'Double title unlink removed a missing link');
    const competingUnlinks=await Promise.all([
      remove(port,removeAuthorPath,secureCookie,{expectedVersion:8}),
      remove(port,removeAuthorPath,secureCookie,{expectedVersion:8}),
    ]);
    check(competingUnlinks.map(row=>row.status).sort().join(',')==='200,409',
      'Concurrent author unlinks lost a parent metadata revision');
    const successful=competingUnlinks.find(row=>row.status===200)!;
    check(adminCatalogWorkAuthorAppendedSchema.parse(JSON.parse(successful.body))
      .metadataVersion===9,'Canonical author unlink did not advance metadata revision');
    check((await remove(port,removePrimaryPath,secureCookie,{
      expectedVersion:9,
    })).status===409,'Last canonical author link could be unlinked');
    check((await remove(port,authorsPath+'/'+randomUUID(),secureCookie,{
      expectedVersion:9,
    })).status===404,'Unrelated author link was removed');
    const afterUnlink=adminCatalogWorkDetailSchema.parse(JSON.parse(
      (await call(true,port,root+'/works/'+linkedWorkId,bearer)).body));
    check(afterUnlink.work.metadataVersion===9&&
      afterUnlink.authors.length===1&&afterUnlink.authors[0]?.id===cookieId&&
      !afterUnlink.titles.some(t=>t.id===
        adminCatalogTitleAppendedSchema.parse(JSON.parse(titleMade.body)).id)&&
      afterUnlink.titles.some(t=>t.kind==='original')&&
      afterUnlink.editions.length===2&&
      afterUnlink.editions.some(e=>e.id===createdEdition.id)&&
      (await pool.query('SELECT id FROM authors WHERE id=$1::uuid',
        [author.id])).rowCount===1,
      'Unlink changed the canonical author, original title, edition or nonoptional relation');
    const relationAudits=await pool.query<{
      action:string;actor_id:string;request_id:string;
      before_json:{workMetadataVersion:number};
      after_json:{workMetadataVersion:number};
    }>(
      'SELECT action,actor_id,request_id,before_json,after_json FROM audit_events WHERE entity_id=$1::uuid AND action IN ($2,$3) ORDER BY created_at',
      [linkedWorkId,'work.title.remove','work.author.remove'],
    );
    check(relationAudits.rows.length===2&&
      relationAudits.rows.every(row=>
        row.actor_id===editor.userId&&
        typeof row.request_id==='string'&&
        row.request_id!=='forged-unlink-trace'&&
        row.after_json.workMetadataVersion===row.before_json.workMetadataVersion+1)&&
      relationAudits.rows.some(row=>row.action==='work.title.remove')&&
      relationAudits.rows.some(row=>row.action==='work.author.remove'),
      'Removed relations emitted unauthenticated, partial or false-positive audits');
    // #13: real PostgreSQL metadata-only diff via live admin TLS+DB MFA/RBAC.
    // Fixtures are synthetic, immutable DRAFT revisions without a real asset.
    const chapterId=randomUUID(),editedBlockId=randomUUID(),addedBlockId=randomUUID();
    const sourceBefore='Synthetic earlier Folio revision for '+suffix;
    const sourceAfter='Synthetic replacement Folio revision for '+suffix;
    const sourceAdded='New synthetic note for '+suffix;
    const makeDiffBlock=(value:string,id:string,ordinal:number)=>({
      blockId:id,ordinal,kind:'paragraph' as const,
      locator:{format:'text' as const,path:'synthetic/admin-diff/'+ordinal},
      sourceText:value,textSha256:sha256Text(value),
      includeNormal:true,includeRsvp:true,includeAudio:false,
    });
    const diffBase={
      editionId:createdEdition.id,language:'en' as const,
      rawArtifactKey:'test-private/'+randomUUID(),
      rawSha256:sha256Text('synthetic source before '+suffix),
      parserVersion:'synthetic-no-ocr-1',
      provenance:{sourceName:'folio_test_manual_only'},
      chapters:[{chapterId,ordinal:0,heading:'Synthetic example chapter',
        blocks:[makeDiffBlock(sourceBefore,editedBlockId,0)]}],
    };
    const firstContent=await createContentRevision(db,editor.userId,diffBase);
    const changedContent=await createContentRevision(db,editor.userId,{
      ...diffBase,parentRevisionId:firstContent.revision.id,
      rawArtifactKey:'test-private/'+randomUUID(),
      rawSha256:sha256Text('synthetic source after '+suffix),
      chapters:[{chapterId,ordinal:0,heading:'Synthetic example chapter',
        blocks:[
          makeDiffBlock(sourceAfter,editedBlockId,0),
          makeDiffBlock(sourceAdded,addedBlockId,1),
        ]}],
    });


    // #13: real private chapter text over Nest direct TLS and Folio PostgreSQL.
    // Earlier immutable revision must still return its original paragraph.
    const chapterPath=(revisionId:string,workId=linkedWorkId,editionId=createdEdition.id)=>
      root+'/works/'+workId+'/editions/'+editionId+
      '/revisions/'+revisionId+'/chapters/'+chapterId;
    const beforeChapter=await call(true,port,chapterPath(firstContent.revision.id),bearer);
    check(beforeChapter.status===200&&
      beforeChapter.headers['cache-control']==='private, no-store',
      'Authenticated admin could not read immutable original chapter');
    const beforeParsed=adminContentChapterResponseSchema.parse(
      JSON.parse(beforeChapter.body));
    check(beforeParsed.workId===linkedWorkId&&
      beforeParsed.editionId===createdEdition.id&&
      beforeParsed.revision.id===firstContent.revision.id&&
      beforeParsed.revision.parentRevisionId===null&&
      beforeParsed.revision.sourceSha256===diffBase.rawSha256&&
      beforeParsed.revision.provenanceId===firstContent.revision.provenanceId&&
      beforeParsed.chapter.id===chapterId&&
      beforeParsed.chapter.heading==='Synthetic example chapter'&&
      beforeParsed.blocks.length===1&&
      beforeParsed.blocks[0]?.sourceText===sourceBefore&&
      beforeParsed.blocks[0]?.textSha256===sha256Text(sourceBefore),
      'Chapter preview lost source SHA, chapter ordering or original immutable text');
    const afterChapter=await call(true,port,chapterPath(changedContent.revision.id),
      readonlyEditionBearer);
    check(afterChapter.status===200,
      'Verified MFA read-only catalog role could not read chapter');
    const afterParsed=adminContentChapterResponseSchema.parse(
      JSON.parse(afterChapter.body));
    check(afterParsed.revision.parentRevisionId===firstContent.revision.id&&
      afterParsed.blocks.length===2&&
      afterParsed.blocks[0]?.sourceText===sourceAfter&&
      afterParsed.blocks[1]?.sourceText===sourceAdded&&
      afterParsed.blocks[0]?.ordinal===0&&afterParsed.blocks[1]?.ordinal===1,
      'New revision overwrote old chapter or lost paragraph order');
    check((await call(true,port,chapterPath(firstContent.revision.id))).status===401,
      'Anonymous chapter preview bypassed session authentication');
    check((await call(true,port,chapterPath(firstContent.revision.id),{
      authorization:'Bearer '+guestSession.sessionToken,
    })).status===403,'Unprivileged account received private source text');
    check((await call(true,port,chapterPath(firstContent.revision.id),{
      ...cookie,origin:'https://attacker.example',
    })).status===403,'Cross-origin browser leaked unpublished chapter');
    check((await call(false,plainAddress.port,
      chapterPath(firstContent.revision.id),bearer)).status!==200,
      'Plain HTTP exposed unpublished chapter');
    check((await call(true,port,chapterPath(firstContent.revision.id,randomUUID()),
      bearer)).status===404,'Cross-work chapter scope returned source text');
    check((await call(true,port,chapterPath(firstContent.revision.id,
      linkedWorkId,randomUUID()),bearer)).status===404,
      'Cross-edition chapter scope returned source text');
    check((await call(true,port,chapterPath(randomUUID()),bearer)).status===404,
      'Unknown revision exposed draft source');
    check((await call(true,port,
      chapterPath(firstContent.revision.id)+'?ownerId='+editor.userId,
      bearer)).status===400,'Untrusted query altered private chapter selection');
    check(!beforeChapter.body.includes(diffBase.rawArtifactKey)&&
      !beforeChapter.body.includes('rawArtifactKey')&&
      !beforeChapter.body.includes('sourceLocator')&&
      !beforeChapter.body.includes('sourceSnapshot')&&
      !beforeChapter.body.includes(editor.email)&&
      !beforeChapter.body.includes(native.sessionToken),
      'Private raw artifact/actor metadata leaked in chapter response');
    console.log('ADMIN CHAPTER HTTPS PASS: immutable revision text, SHA, stable blocks, MFA/RBAC, 401/403/404 and no raw artifact keys.');

    // #14 rights:read metadata only. Pending claims MUST NOT publish content.
    // Distinct private evidence and source URL exist in PostgreSQL, never JSON.
    const rightsWork=await submitRightsEvidence(db,editor.userId,{
      workId:linkedWorkId,licenseKind:'restricted',
      evidence:'Synthetic private rights EVIDENCE_WORK_'+suffix+' not approved.',
      sourceUrl:'https://example.org/private-evidence/'+suffix,
      territories:['TR'],displayAllowed:true,
      translationAllowed:false,audioAllowed:false,sharingAllowed:false,
    });
    const rightsRevision=await submitRightsEvidence(db,editor.userId,{
      workId:linkedWorkId,editionId:createdEdition.id,
      revisionId:changedContent.revision.id,licenseKind:'restricted',
      evidence:'Synthetic private rights EVIDENCE_REVISION_'+suffix+' not approved.',
      sourceUrl:'https://example.org/hidden-revision/'+suffix,
      territories:['TR','GB'],displayAllowed:false,
      translationAllowed:false,audioAllowed:false,sharingAllowed:false,
    });
    const rightsPath=root+'/works/'+linkedWorkId+'/rights';
    check((await call(true,port,rightsPath+'?limit=1',{
      authorization:'Bearer '+guestSession.sessionToken,
    })).status===403,'Unauthenticated rights:read guest saw rights claims');
    check((await call(true,port,rightsPath+'?limit=1',
      readonlyEditionBearer)).status===403,
      'catalog:read-only role was allowed to read rights:read evidence claims');
    check((await call(true,port,rightsPath+'?limit=1',{
      ...cookie,origin:'https://evil.example',
    })).status===403,'Cross-origin browser leaked rights claims');
    check((await call(true,port,rightsPath+'?limit=1',{
      ...cookie,authorization:'Bearer '+native.sessionToken,
    })).status===401,'Mixed cookie/bearer bypassed rights:read transport');
    check((await call(false,plainAddress.port,rightsPath+'?limit=1',
      bearer)).status!==200,'Plain HTTP leaked rights claims metadata');
    for(const invalid of [
      rightsPath+'?cursor=../private',rightsPath+'?limit=999',
      rightsPath+'?ownerId='+editor.userId,
      root+'/works/'+randomUUID()+'/rights',
    ]){
      const response=await call(true,port,invalid,bearer);
      check([400,404].includes(response.status),
        'Untrusted rights query or foreign work leaked evidence claims');
    }
    const pendingWeb=await call(true,port,rightsPath+'?limit=1',secureCookie);
    check(pendingWeb.status===200&&
      pendingWeb.headers['cache-control']==='private, no-store',
      'Verified exact-origin rights:read Web MFA request failed');
    const rightsFirst=adminCatalogRightsLedgerSchema.parse(JSON.parse(pendingWeb.body));
    check(rightsFirst.workId===linkedWorkId&&rightsFirst.isMetadataOnly&&
      rightsFirst.items.length===1&&rightsFirst.items[0]?.reviewStatus==='pending'&&
      rightsFirst.nextCursor===rightsFirst.items[0]?.id,
      'Rights claim read page is unbounded, altered or incorrectly approved');
    const rightsSecondWire=await call(true,port,
      rightsPath+'?limit=1&cursor='+rightsFirst.nextCursor,bearer);
    check(rightsSecondWire.status===200,'Second rights UUID-cursor page failed');
    const rightsSecond=adminCatalogRightsLedgerSchema.parse(JSON.parse(rightsSecondWire.body));
    check(rightsSecond.items.length===1&&rightsSecond.nextCursor===null&&
      new Set([rightsFirst.items[0]?.id,rightsSecond.items[0]?.id]).size===2&&
      [rightsWork.id,rightsRevision.id].every(id=>
        [rightsFirst.items[0]?.id,rightsSecond.items[0]?.id].includes(id)),
      'Rights claims page cursor skipped or duplicated evidence');
    const bothRights=[...rightsFirst.items,...rightsSecond.items];
    check(bothRights.some(row=>row.editionId===null&&
      row.revisionId===null&&row.claims.display===true)&&
      bothRights.some(row=>row.editionId===createdEdition.id&&
        row.revisionId===changedContent.revision.id&&
        row.claims.display===false),
      'Rights claim scopes or action booleans were conflated');
    const rawRights=pendingWeb.body+rightsSecondWire.body;
    check(!rawRights.includes('EVIDENCE_WORK_')&&
      !rawRights.includes('EVIDENCE_REVISION_')&&
      !rawRights.includes('private-evidence')&&
      !rawRights.includes('hidden-revision')&&
      !rawRights.includes('sourceUrl')&&
      !rawRights.includes('evidence')&&
      !rawRights.includes('licenseKind')&&
      !rawRights.includes('reviewedBy')&&
      !rawRights.includes(editor.email)&&
      !rawRights.includes(native.sessionToken),
      'Rights claim metadata returned raw legal evidence or reviewer secret');
    console.log('ADMIN RIGHTS LEDGER HTTPS PASS: rights:read MFA not catalog-only, UUID cursor, pending/no publish and no evidence leaks.');


    // #14: PENDING claims -> rights:review MFA -> territory/action grant.
    // Only synthetic Folio-only data; this is NOT a real legal approval.
    const rightsSubmitPath=root+'/works/'+linkedWorkId+'/rights';
    const rightsDecisionPath=rightsSubmitPath+'/decision';
    const rightsBearer={authorization:'Bearer '+rightsSession.sessionToken};
    const rightsQuery=(territory:string,action:string)=>
      rightsDecisionPath+'?editionId='+createdEdition.id+
      '&revisionId='+changedContent.revision.id+
      '&territory='+territory+'&action='+action;
    const baseClaim={
      workId:linkedWorkId,
      evidence:'Folio-only synthetic rights evidence for admin HTTPS '+suffix,
      licenseKind:'synthetic-lab',territories:['TR'],
      displayAllowed:true,translationAllowed:false,
      audioAllowed:false,sharingAllowed:false,
    };
    check((await post(port,rightsSubmitPath,{},baseClaim)).status===401,
      'Anonymous rights submission was allowed');
    check((await post(port,rightsSubmitPath,readonlyEditionBearer,
      baseClaim)).status===403,'Read-only catalog role submitted legal claim');
    check((await post(port,rightsSubmitPath,bearer,{
      ...baseClaim,workId:randomUUID(),
    })).status===400,'Rights submission crossed work boundary');
    check((await post(port,rightsSubmitPath,bearer,{
      ...baseClaim,evidence:'tiny',
    })).status===400,'Invalid rights evidence accepted');
    const createdRightIds:string[]=[];
    for(const part of [
      {},
      {editionId:createdEdition.id},
      {editionId:createdEdition.id,revisionId:changedContent.revision.id},
    ]){
      const created=await post(port,rightsSubmitPath,bearer,{
        ...baseClaim,...part,
      });
      check(created.status===201&&
        created.headers['cache-control']==='private, no-store',
        'Verified editor cannot submit PENDING scoped rights');
      const item=adminRightsClaimCreatedSchema.parse(JSON.parse(created.body));
      check(item.reviewStatus==='pending','Rights claim created approved without review');
      createdRightIds.push(item.id);
    }

    const evidencePath=rightsSubmitPath+'/'+createdRightIds[2]+'/evidence';
    const evidenceReply=await call(true,port,evidencePath,rightsBearer);
    check(evidenceReply.status===200&&
      evidenceReply.headers['cache-control']==='private, no-store',
      'Verified rights reviewer could not inspect pending private evidence');
    const legal=adminRightsEvidenceSchema.parse(JSON.parse(evidenceReply.body));
    check(legal.workId===linkedWorkId&&
      legal.editionId===createdEdition.id&&
      legal.revisionId===changedContent.revision.id&&
      legal.evidence===baseClaim.evidence&&
      legal.reviewStatus==='pending'&&legal.claims.display===true&&
      legal.territories.length===1&&legal.territories[0]==='TR'&&
      !evidenceReply.body.includes(native.sessionToken),
      'Reviewer evidence content was lost, widened or leaked a session');
    check((await call(true,port,evidencePath,bearer)).status===403,
      'Ordinary catalog editor obtained private legal evidence');
    check((await call(true,port,evidencePath,readonlyEditionBearer)).status===403,
      'Read-only role obtained private legal evidence');
    check((await call(true,port,evidencePath,{})).status===401,
      'Anonymous user read private legal evidence');
    check((await call(true,port,root+'/works/'+randomUUID()+
      '/rights/'+createdRightIds[2]+'/evidence',rightsBearer)).status===404,
      'Evidence from another work crossed the scoped reviewer boundary');
    check((await call(false,plainAddress.port,evidencePath,
      rightsBearer)).status!==200,'Plain HTTP returned private legal evidence');
    const pendingDecision=await call(true,port,rightsQuery('TR','display'),bearer);
    check(pendingDecision.status===200&&
      adminRightsDecisionResultSchema.parse(JSON.parse(pendingDecision.body))
        .reason==='unreviewed',
      'Unreviewed synthetic claims permitted public display decision');
    check((await call(true,port,rightsQuery('TR','display'),
      readonlyEditionBearer)).status===403,
      'Read-only catalog actor bypassed rights:read role');
    check((await call(true,port,rightsQuery('TUR','display'),bearer)).status===400,
      'Invalid country code was accepted by decision API');
    check((await call(true,port,rightsQuery('TR','display')+'&ownerId='+
      editor.userId,bearer)).status===400,'Untrusted rights query was accepted');
    check((await call(false,plainAddress.port,rightsQuery('TR','display'),
      bearer)).status!==200,'Plain HTTP exposed private rights decisions');
    const rationale='Reviewed for isolated synthetic Folio HTTPS test only.';
    for(const id of createdRightIds){
      const url=rightsSubmitPath+'/'+id;
      check((await patch(port,url,bearer,{
        decision:'approved',reason:rationale,
      })).status===403,'Catalog editor illegally approved rights');
      check((await patch(port,url,rightsBearer,{
        decision:'approved',reason:'short',
      })).status===400,'Malformed rights review rationale was accepted');
      const approved=await patch(port,url,rightsBearer,{
        decision:'approved',reason:rationale,
      });
      check(approved.status===200&&
        adminRightsReviewedSchema.parse(JSON.parse(approved.body))
          .reviewStatus==='approved',
        'Current rights:review MFA did not approve evidence');
    }
    const accepted=adminRightsDecisionResultSchema.parse(JSON.parse(
      (await call(true,port,rightsQuery('TR','display'),bearer)).body));
    check(accepted.allowed&&accepted.reason==='approved',
      'Approved work/edition/revision TR display rights still denied');
    const outside=adminRightsDecisionResultSchema.parse(JSON.parse(
      (await call(true,port,rightsQuery('US','display'),bearer)).body));
    check(!outside.allowed&&outside.reason==='territory',
      'Cross-territory rights were mistakenly accepted');
    const audioDenied=adminRightsDecisionResultSchema.parse(JSON.parse(
      (await call(true,port,rightsQuery('TR','audio'),bearer)).body));
    check(!audioDenied.allowed&&audioDenied.reason==='prohibited',
      'Display approval wrongly granted audio rights');
    check((await patch(port,rightsSubmitPath+'/'+createdRightIds[2],
      rightsBearer,{decision:'approved',reason:rationale})).status===200,
      'Repeat approved claim unexpectedly failed');
    const withdrawn=await patch(port,rightsSubmitPath+'/'+createdRightIds[2],
      rightsBearer,{decision:'withdrawn',reason:rationale});
    check(withdrawn.status===200&&
      adminRightsReviewedSchema.parse(JSON.parse(withdrawn.body))
        .reviewStatus==='withdrawn',
      'Rights reviewer could not withdraw prior approval');
    const afterWithdraw=adminRightsDecisionResultSchema.parse(JSON.parse(
      (await call(true,port,rightsQuery('TR','display'),bearer)).body));
    check(!afterWithdraw.allowed&&afterWithdraw.reason==='unreviewed',
      'Withdrawn rights still approved for public display');
    check((await patch(port,rightsSubmitPath+'/'+createdRightIds[2],
      rightsBearer,{decision:'approved',reason:rationale})).status===409,
      'Withdrawn rights could be silently restored');
    check((await patch(port,root+'/works/'+randomUUID()+
      '/rights/'+createdRightIds[0],rightsBearer,{
        decision:'approved',reason:rationale,
      })).status===404,'Foreign work ID allowed rights decision update');
    const auditedRights=await pool.query<{
      action:string;actor_id:string;request_id:string;
      before_json:unknown;after_json:unknown;
    }>('SELECT action,actor_id,request_id,before_json,after_json '+
      'FROM audit_events WHERE entity_type=$1 AND entity_id=$2::uuid '+
      'ORDER BY created_at',
      ['rights_record',createdRightIds[2]]);
    check(auditedRights.rows.some(row=>
      row.action==='rights.evidence.submit'&&
      row.actor_id===editor.userId&&!!row.request_id)&&
      auditedRights.rows.some(row=>
      row.action==='rights.review.approved'&&
      row.actor_id===rightsReviewer.userId&&
      !!row.before_json&&!!row.after_json&&!!row.request_id)&&
      auditedRights.rows.some(row=>
      row.action==='rights.review.withdrawn'&&
      row.actor_id===rightsReviewer.userId&&!!row.request_id),
      'Rights claim/review/withdraw lacked actual actor or before-after audit');
    console.log('ADMIN RIGHTS DECISION HTTPS PASS: pending deny, MFA editor submit, rights reviewer approval/withdrawal, TR permit/US deny/audio deny, 401/403/400/409 and audit.');

    // A verified revision picker must reveal only bounded ID/parent metadata.
    // Each page revalidates role+same-device MFA in the same DB snapshot.
    const revisionListPath=root+'/works/'+linkedWorkId+
      '/editions/'+createdEdition.id+'/revisions';
    check((await call(true,port,revisionListPath+'?limit=1',{
      authorization:'Bearer '+guestSession.sessionToken,
    })).status===403,'Guest received unpublished revision identifiers');
    check((await call(true,port,revisionListPath+'?limit=1',{
      ...cookie,origin:'https://attacker.example',
    })).status===403,'Cross-origin Web cookie leaked private revision IDs');
    check((await call(true,port,revisionListPath+'?limit=1',{
      ...cookie,authorization:'Bearer '+native.sessionToken,
    })).status===401,'Mixed bearer and cookie bypassed revision-list transport');
    check((await call(false,plainAddress.port,revisionListPath+'?limit=1',bearer))
      .status!==200,'Plain HTTP disclosed unpublished edition revision IDs');
    for(const bad of [
      revisionListPath+'?cursor=../escape',
      revisionListPath+'?limit=999',
      revisionListPath+'?ownerId='+editor.userId,
      root+'/works/'+randomUUID()+'/editions/'+createdEdition.id+'/revisions',
      root+'/works/'+linkedWorkId+'/editions/'+randomUUID()+'/revisions',
    ]){
      const response=await call(true,port,bad,bearer);
      check([400,404].includes(response.status),
        'Malformed revision-list scope or metadata query disclosed resources');
    }
    const viewerList=await call(true,port,revisionListPath,readonlyEditionBearer);
    check(viewerList.status===200,'Verified MFA read-only reviewer cannot see revision IDs');
    const listFirst=await call(true,port,revisionListPath+'?limit=1',secureCookie);
    check(listFirst.status===200&&
      listFirst.headers['cache-control']==='private, no-store',
      'Same-origin verified Web MFA could not load private revision IDs');
    const listPageA=adminCatalogRevisionListSchema.parse(JSON.parse(listFirst.body));
    check(listPageA.isMetadataOnly&&listPageA.items.length===1&&
      listPageA.nextCursor===listPageA.items[0]?.id,
      'Revision selector first bounded UUID page does not cursor correctly');
    const listSecond=await call(true,port,
      revisionListPath+'?limit=1&cursor='+listPageA.nextCursor,bearer);
    check(listSecond.status===200,'Revision selector UUID cursor page denied');
    const listPageB=adminCatalogRevisionListSchema.parse(JSON.parse(listSecond.body));
    const listedIds=[...listPageA.items,...listPageB.items].map(row=>row.id);
    check(listPageB.items.length===1&&listPageB.nextCursor===null&&
      listedIds.slice().sort().join(',')===
        [firstContent.revision.id,changedContent.revision.id].sort().join(',')&&
      listPageA.items[0]!.id<listPageB.items[0]!.id,
      'Revision selector lost stable edition identity or ordered pagination');
    const rawList=listFirst.body+listSecond.body+viewerList.body;
    check(!rawList.includes(sourceBefore)&&!rawList.includes(sourceAfter)&&
      !rawList.includes(sourceAdded)&&!rawList.includes('sourceText')&&
      !rawList.includes('rawArtifactKey')&&!rawList.includes('rawSha256')&&
      !rawList.includes('provenance')&&!rawList.includes('createdBy')&&
      !rawList.includes(editor.email)&&!rawList.includes(native.sessionToken),
      'Verified revision identity picker leaked source/artifact/editor credentials');
    console.log('ADMIN REVISION PICKER HTTPS PASS: same-tx MFA, strict ID pages, guest/foreign-origin denial and no source bytes.');

    const revisionPath=root+'/works/'+linkedWorkId+
      '/editions/'+createdEdition.id+'/revisions/'+changedContent.revision.id+'/diff';
    const revisionQuery='?fromRevisionId='+firstContent.revision.id+'&limit=1';
    check((await call(true,port,revisionPath+revisionQuery,{
      authorization:'Bearer '+guestSession.sessionToken,
    })).status===403,
      'Non-admin signed-in guest could read private canonical source SHA diff');
    check((await call(true,port,revisionPath+revisionQuery,{
      ...cookie,origin:'https://evil.example',
    })).status===403,'Cross-origin browser cookie read an unpublished SHA diff');
    check((await call(true,port,revisionPath+revisionQuery,{
      ...cookie,authorization:'Bearer '+native.sessionToken,
    })).status===401,'Mixed bearer and cookie bypassed source-diff transport');
    check((await call(false,plainAddress.port,revisionPath+revisionQuery,bearer))
      .status!==200,'Plain HTTP leaked authenticated unpublished source diff');
    for(const invalid of [
      revisionPath+'?fromRevisionId=not-a-uuid',
      revisionPath+revisionQuery+'&actorId='+editor.userId,
      revisionPath+revisionQuery+'&limit=999',
      root+'/works/'+randomUUID()+'/editions/'+createdEdition.id+
        '/revisions/'+changedContent.revision.id+'/diff'+revisionQuery,
      root+'/works/'+linkedWorkId+'/editions/'+randomUUID()+
        '/revisions/'+changedContent.revision.id+'/diff'+revisionQuery,
    ]){
      const response=await call(true,port,invalid,bearer);
      check([400,404].includes(response.status),
        'Malformed or wrong-scope canonical revision diff returned private metadata');
    }
    const viewerDiff=await call(true,port,revisionPath+revisionQuery,
      readonlyEditionBearer);
    check(viewerDiff.status===200,
      'Real read-only viewer with current same-device MFA cannot read allowed diff');
    const firstDiff=await call(true,port,revisionPath+revisionQuery,secureCookie);
    check(firstDiff.status===200&&
      firstDiff.headers['cache-control']==='private, no-store',
      'Verified same-origin HTTPS Web cookie could not read a private revision diff');
    const firstDiffData=adminCatalogRevisionDiffSchema.parse(JSON.parse(firstDiff.body));
    check(firstDiffData.isMetadataOnly&&firstDiffData.summary.added===1&&
      firstDiffData.summary.text_changed===1&&
      firstDiffData.items.length===1&&firstDiffData.nextCursor!==null,
      'Versioned source diff counts or stable paginated IDs are incorrect');
    const secondDiff=await call(true,port,
      revisionPath+revisionQuery+'&cursor='+firstDiffData.nextCursor,bearer);
    check(secondDiff.status===200,'Cursor-based revision diff page failed');
    const secondDiffData=adminCatalogRevisionDiffSchema.parse(JSON.parse(secondDiff.body));
    check(secondDiffData.items.length===1&&secondDiffData.nextCursor===null&&
      new Set([...firstDiffData.items,...secondDiffData.items].map(item=>item.blockId))
        .size===2&&
      [firstDiffData.items[0]?.kind,secondDiffData.items[0]?.kind]
        .sort().join(',')==='added,text_changed',
      'Revision diff merged changed and added blocks or lost cursor identity');
    const diffJson=firstDiff.body+secondDiff.body+viewerDiff.body;
    check(!diffJson.includes(sourceBefore)&&!diffJson.includes(sourceAfter)&&
      !diffJson.includes(sourceAdded)&&
      !diffJson.includes('rawArtifactKey')&&
      !diffJson.includes('sourceText')&&
      !diffJson.includes('provenance')&&
      !diffJson.includes(editor.email)&&!diffJson.includes(native.sessionToken),
      'Canonical source diff leaked raw text, secret credential or provenance');
    const unauthorizedPair=await call(true,port,
      revisionPath+'?fromRevisionId='+randomUUID(),bearer);
    check(unauthorizedPair.status===404,
      'A verified reader learned metadata for an absent/foreign source revision');
    console.log('ADMIN REVISION DIFF HTTPS PASS: same-tx catalog:read MFA/RBAC, read-only role, cookie, UTF-8 SHA, 1-item cursor and no source bytes.');


    check((await post(port,editionsPath,secureCookie,{
      expectedVersion:1,language:'en',label:'Stale Edition',
    })).status===409,'Stale previously read edition edit was accepted');
    check((await post(port,editionsPath,secureCookie,{
      expectedVersion:4,language:'en',label:'Should not publish',status:'published',
    })).status===400,'Edition append allowed direct publication');

    check((await call(true,port,search,{
      ...cookie,origin:'https://wrong-origin.example',
    })).status===403,'Cross-origin cookie read private admin draft');
    check((await call(true,port,root+'/works/'+createdWork.id,{
      ...cookie,origin:'https://wrong-origin.example',
    })).status===403,'Cross-site cookie exposed relational catalog metadata');
    check((await call(true,port,search,{
      ...cookie,'sec-fetch-site':'cross-site',
    })).status===403,'Cross-site browser metadata read draft');
    check((await call(true,port,search,{
      ...cookie,authorization:'Bearer '+native.sessionToken,
    })).status===401,'Mixed bearer + cookie bypassed transport segregation');
    check((await call(true,port,root+'/authors/'+nativeDraftId,{
      ...cookie,authorization:'Bearer '+native.sessionToken,
    })).status===401,
      'Mixed bearer+cookie authorized canonical author snapshot');
    const leaked=JSON.stringify([response.body,browser.body,names.body]);
    check(!leaked.includes(password)&&!leaked.includes(native.sessionToken)&&
      !leaked.includes(web.sessionToken)&&!leaked.includes(editor.email)&&
      !leaked.includes(guest.email),
      'Admin read-only metadata responses disclosed session or account secrets');
    // Synthetic folio_test only: make the session old enough that a proof
    // can be expired WITHOUT also failing the independent "MFA predates
    // session" guard. Otherwise this negative test proves the wrong check.
    const past=Date.now();
    await pool.query(
      'UPDATE user_sessions SET created_at=$1 WHERE id=$2::uuid',
      [new Date(past-20*60_000),web.sessionId],
    );
    await pool.query(
      'UPDATE admin_session_mfa SET verified_at=$1,expires_at=$2 WHERE session_id=$3::uuid',
      [new Date(past-10*60_000),new Date(past-5*60_000),web.sessionId],
    );
    const expiredFixture=await pool.query<{
      created_at:Date;verified_at:Date;expires_at:Date;
    }>('SELECT s.created_at,m.verified_at,m.expires_at FROM user_sessions s JOIN admin_session_mfa m ON m.session_id=s.id WHERE s.id=$1::uuid',
      [web.sessionId]);
    const expiredRow=expiredFixture.rows[0];
    check(expiredRow&&expiredRow.verified_at>=expiredRow.created_at&&
      expiredRow.expires_at>expiredRow.verified_at&&
      expiredRow.expires_at.getTime()<Date.now(),
      'Synthetic expired MFA proof could be denied for a different timestamp reason');
    check((await call(true,port,search,cookie)).status===403,
      'Expired same-device MFA remained authorized');
    check((await call(true,port,root+'/works/'+createdWork.id,cookie)).status===403,
      'Expired exact-device MFA could still fetch unpublished work details');
    check((await call(true,port,revisionPath+revisionQuery,cookie)).status===403,
      'Expired same-device MFA still read private canonical revision diff');
    check((await patch(port,workPath,secureCookie,{
      expectedVersion:3,firstPublicationYear:1881,
    })).status===403,'Expired exact-device MFA modified canonical work metadata');
    check((await post(port,createRoot,secureCookie,{
      canonicalName:'Expired web editor '+suffix,
    })).status===403,'Expired same-device MFA still authorized catalog draft POST');
    check((await post(port,titlesPath,secureCookie,{
      expectedVersion:4,language:'en',title:'Unauthorized',kind:'alternate',
    })).status===403,'Expired factor still appended alternate title');
    check((await patch(port,editEditionPath,secureCookie,{
      expectedVersion:7,label:'Expired editor',
    })).status===403,'Expired MFA still PATCHed edition metadata');
    await pool.query(
      'UPDATE admin_role_memberships SET revoked_at=$1 WHERE user_id=$2::uuid',
      [new Date(),editor.userId],
    );
    check((await call(true,port,search,bearer)).status===403,
      'Revoked database role could still read private draft');
    check((await call(true,port,root+'/authors/'+nativeDraftId,bearer)).status===403,
      'Revoked persisted role could still fetch canonical author metadata');
    check((await patch(port,authorPath,bearer,{
      expectedVersion:2,canonicalName:'Recalled writer',
    })).status===403,'Revoked catalog:edit role still modified canonical author');
    check((await post(port,createRoot,bearer,{
      canonicalName:'Revoked editor '+suffix,
    })).status===403,'Revoked persisted role still authorized draft POST');

    const specResponse=await call(true,port,'/openapi-json');
    check(specResponse.status===200,'HTTPS OpenAPI missing');
    const spec=JSON.parse(specResponse.body) as {
      paths:Record<string,Record<string,unknown>>;
    };
    check(!!spec.paths[root+'/works']?.get&&
      !!spec.paths[root+'/authors']?.get&&
      !!spec.paths[root+'/works']?.post&&
      !!spec.paths[root+'/authors']?.post&&
      !!spec.paths[root+'/works/{workId}']?.get&&
      !!spec.paths[root+'/authors/{authorId}']?.get&&
      !!spec.paths[root+'/works/{workId}']?.patch&&
      !!spec.paths[root+'/authors/{authorId}']?.patch&&
      !!spec.paths[root+'/works/{workId}/editions']?.post&&
      !!spec.paths[root+'/works/{workId}/editions/{editionId}']?.patch&&
      !!spec.paths[root+'/works/{workId}/editions/{editionId}/revisions/{toRevisionId}/diff']?.get&&
      !!spec.paths[root+'/works/{workId}/titles']?.post&&
      !!spec.paths[root+'/works/{workId}/authors']?.post&&
      !!spec.paths[root+'/works/{workId}/authors/{authorId}']?.delete&&
      !!spec.paths[root+'/works/{workId}/match-reviews']?.get&&
      !!spec.paths[root+'/works/{workId}/match-reviews']?.post&&
      !!spec.paths[root+'/works/{workId}/match-reviews/{reviewId}']?.patch&&
      !!spec.paths[root+'/works/{workId}/import-reviews']?.get&&
      !!spec.paths[root+'/works/{workId}/import-reviews']?.post&&
      !!spec.paths[root+'/works/{workId}/import-reviews/{reviewId}']?.patch&&
      !!spec.paths[root+'/works/{workId}/titles/{titleId}']?.patch&&
      !!spec.paths[root+'/works/{workId}/authors/{authorId}']?.patch&&
      !!spec.paths[root+'/works/{workId}/editions/{editionId}']?.delete&&
      !!spec.paths[root+'/works/{workId}/titles/{titleId}']?.delete&&
      !spec.paths[root+'/users'],
      'Secure admin catalog GET/POST routes or user-search denial missing in OpenAPI');
    process.env.FOLIO_ADMIN_CATALOG_HTTP_MODE='off';
    check((await call(true,port,search,bearer)).status===404,
      'Flag shutoff did not immediately hide private catalog API');
    check((await call(true,port,revisionPath+revisionQuery,bearer)).status===404,
      'Disabling read flag left the private revision diff reachable');
    check((await call(true,port,root+'/works/'+createdWork.id,bearer)).status===404&&
      (await call(true,port,root+'/authors/'+nativeDraftId,bearer)).status===404,
      'Disabling catalog read mode left unpublished detail endpoints available');
    check((await patch(port,workPath,bearer,{
      expectedVersion:3,firstPublicationYear:1882,
    })).status===404,'Read flag shutoff did not hide metadata PATCH');
    check((await post(port,createRoot,bearer,draftAuthor)).status===404,
      'Disabling catalog HTTP left POST author creation reachable');
    process.env.FOLIO_ADMIN_CATALOG_HTTP_MODE='direct-tls-only';
    process.env.FOLIO_ADMIN_CATALOG_WRITE_MODE='off';
    check((await post(port,createRoot,bearer,draftAuthor)).status===404,
      'Independent admin write flag failed to turn off mutation');
    check((await post(port,matchPath,bearer,candidate)).status===404,
      'Independent write flag enabled match review proposal');
    check((await post(port,incomingClaimPath,bearer,claim)).status===404,
      'Independent write flag left incoming package review intake enabled');
    check((await patch(port,optionalPath,bearer,{expectedVersion:4,title:'Off'})).status===404,
      'Independent write flag left optional title PATCH enabled');
    check((await remove(port,rightsPath,bearer,{expectedVersion:4})).status===404,
      'Independent write flag left edition DELETE enabled');
    check((await post(port,editionsPath,bearer,{
      expectedVersion:4,language:'tr',label:'Unavailable',
    })).status===404,
      'Disabled independent write flag exposed edition append');
    check((await patch(port,editEditionPath,bearer,{
      expectedVersion:7,label:'Disabled editor',
    })).status===404,'Independent write flag off still allowed edition PATCH');
    check((await remove(port,removePrimaryPath,bearer,{
      expectedVersion:9,
    })).status===404,'Independent write flag off left relation DELETE enabled');
    check((await patch(port,authorPath,bearer,{
      expectedVersion:2,sortName:'Should not update',
    })).status===404,'Independent write flag shutoff left PATCH enabled');
    console.log('ADMIN CATALOG RELATION UNLINK PASS: direct TLS + DB/MFA/HMAC-CSRF, 200/400/403/404/409, original/last-author immutability, double-delete/concurrency denial, correlated audit and unaltered editions.');
    console.log('ADMIN CATALOG HTTPS PASS: versioned edition metadata PATCH and FK rollback, 200/409 concurrency, before-after audit and immutable source/language;  canonical multi-author/edition/ISBN/translated title MFA/CSRF work relationship appends, strict versions, FK rollback and 201/409 concurrency; real Folio-only PostgreSQL/TLS; default-off catalog GET/POST/PATCH; persisted MFA+RBAC native/cookie/CSRF, bounded DTO; optimistic metadata versions FOR UPDATE concurrency exactly one 200 vs one 409, atomic canonical author aliases/external IDs and draft original title+year edits, trusted server audit before/after; no content, no publication rights; 31+ existing browser E2E separate.');
  }finally{
    if(liveProxy){
      liveProxy.closeAllConnections();
      await new Promise<void>(done=>liveProxy!.close(()=>done()));
    }
    if(httpsApp)await httpsApp.close();
    if(httpApp)await httpApp.close();
    await pool.end();
    for(const name of names){
      if(original[name]===undefined)delete process.env[name];
      else process.env[name]=original[name];
    }
    rmSync(temp,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
