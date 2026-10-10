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
  adminCatalogAuthorCreatedSchema,adminCatalogAuthorPageSchema,
  adminCatalogWorkCreatedSchema,adminCatalogWorkPageSchema,apiErrorSchema,
} from '@folio/contracts';
import {
  createCanonicalAuthor,createCanonicalWork,createFolioDb,registerPendingAccount,
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
    await mfa(web.sessionId,editor.userId);
    const browser=await call(true,port,search,cookie);
    check(browser.status===200&&
      adminCatalogWorkPageSchema.parse(JSON.parse(browser.body)).items.length===1,
      'Real direct-TLS HttpOnly Web session could not query MFA-verified metadata');
    check((await call(true,port,search,{
      ...cookie,origin:'https://wrong-origin.example',
    })).status===403,'Cross-origin cookie read private admin draft');
    check((await call(true,port,search,{
      ...cookie,'sec-fetch-site':'cross-site',
    })).status===403,'Cross-site browser metadata read draft');
    check((await call(true,port,search,{
      ...cookie,authorization:'Bearer '+native.sessionToken,
    })).status===401,'Mixed bearer + cookie bypassed transport segregation');
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
    await pool.query(
      'UPDATE admin_role_memberships SET revoked_at=$1 WHERE user_id=$2::uuid',
      [new Date(),editor.userId],
    );
    check((await call(true,port,search,bearer)).status===403,
      'Revoked database role could still read private draft');

    const specResponse=await call(true,port,'/openapi-json');
    check(specResponse.status===200,'HTTPS OpenAPI missing');
    const spec=JSON.parse(specResponse.body) as {
      paths:Record<string,Record<string,unknown>>;
    };
    check(!!spec.paths[root+'/works']?.get&&
      !!spec.paths[root+'/authors']?.get,
      'Explicit secure admin catalog endpoints missing from versioned OpenAPI');
    process.env.FOLIO_ADMIN_CATALOG_HTTP_MODE='off';
    check((await call(true,port,search,bearer)).status===404,
      'Flag shutoff did not immediately hide private catalog API');
    console.log('ADMIN CATALOG HTTPS PASS: default-off, direct socket TLS, signed-in session + exact-device MFA + DB catalog:read in one transaction, read-only TR/EN drafts, canonical aliases, bounded UUID pagination, wildcard literal, no private bodies/user search, cookie origin and native bearer separation, no-store 4xx/5xx, role revoke/expired MFA denial, OpenAPI. Synthetic folio_test ONLY.');
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
