import 'reflect-metadata';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import type {IncomingHttpHeaders} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
  adminCatalogWorkAuthorAppendedSchema,
} from '@folio/contracts';
import {
  createCanonicalAuthor,createCanonicalWork,createContentRevision,sha256Text,
  createFolioDb,registerPendingAccount,submitRightsEvidence,
  schema,signInVerifiedAccount,verifyAccountEmail,
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
    'FOLIO_WEB_AUTH_MODE',
    'FOLIO_WEB_AUTH_ORIGIN','FOLIO_WEB_CSRF_KEY_HEX',
  ];
  const original=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const temp=mkdtempSync(join(tmpdir(),'folio-admin-catalog-'));
  const {db,pool}=createFolioDb(url);
  let httpsApp:INestApplication|undefined,httpApp:INestApplication|undefined;
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
      viewer=await account();
    await db.insert(schema.adminRoleMemberships).values([
      {userId:editor.userId,role:'editor',grantedBy:guest.userId},
      {userId:moderator.userId,role:'moderator',grantedBy:guest.userId},
      {userId:viewer.userId,role:'read-only',grantedBy:guest.userId},
    ]);
    const native=await signInVerifiedAccount(db,editor.email,password,'android-lab');
    const web=await signInVerifiedAccount(db,editor.email,password,'web-lab');
    const moderatorSession=await signInVerifiedAccount(db,moderator.email,password,'review-lab');
    const guestSession=await signInVerifiedAccount(db,guest.email,password,'guest-lab');
    const viewerSession=await signInVerifiedAccount(db,viewer.email,password,'viewer-lab');
    await mfa(native.sessionId,editor.userId);
    await mfa(moderatorSession.sessionId,moderator.userId);
    await mfa(viewerSession.sessionId,viewer.userId);
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
