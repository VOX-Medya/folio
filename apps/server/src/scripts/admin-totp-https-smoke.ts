import 'reflect-metadata';
import {execFileSync} from 'node:child_process';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
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
  adminTotpEnrollResponseSchema,adminTotpVerifyResponseSchema,apiErrorSchema,
} from '@folio/contracts';
import {
  createFolioDb,registerPendingAccount,verifyAccountEmail,
  signInVerifiedAccount,withVerifiedAdminPermission,schema,
} from '@folio/db';
import {eq} from 'drizzle-orm';
import {ApiExceptionFilter,AppModule,createOpenApiDocument} from '../main.js';

interface Wire{status:number;headers:IncomingHttpHeaders;body:string;}
function check(value:unknown,message:string):asserts value{
  if(!value)throw new Error(message);
}
async function call(secure:boolean,port:number,path:string,method:string,
  headers:Record<string,string>={},body?:unknown):Promise<Wire>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const request=secure?httpsRequest:httpRequest;
  return new Promise((resolve,reject)=>{
    const req=request({
      host:'127.0.0.1',port,path,method,
      headers:{...headers,...(data===undefined?{}:{
        'content-type':'application/json','content-length':String(Buffer.byteLength(data)),
      })},
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
    req.on('timeout',()=>req.destroy(Error('Folio TOTP HTTPS lab timeout')));
    req.end(data);
  });
}
function totpCode(rawBase32:string,step:number):string{
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits=0,value=0;
  const bytes:number[]=[];
  for(const char of rawBase32){
    value=(value<<5)|alphabet.indexOf(char);
    bits+=5;
    if(bits>=8){
      bytes.push((value>>>(bits-8))&255);
      bits-=8;value&=(1<<bits)-1;
    }
  }
  check(bytes.length===20,'Invalid returned TOTP enrollment secret length');
  const counter=Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash=createHmac('sha1',Buffer.from(bytes)).update(counter).digest();
  const offset=hash[19]!&15;
  return String((hash.readUInt32BE(offset)&0x7fffffff)%1_000_000).padStart(6,'0');
}

async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio-only test DB required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||
    !['localhost','127.0.0.1'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('MFA HTTP test may use only Folio loopback folio_test');
  }
  const keys=[
    'FOLIO_ADMIN_TOTP_HTTP_MODE','FOLIO_ADMIN_TOTP_KEY_HEX',
    'FOLIO_ADMIN_TOTP_V2_KEY_HEX','FOLIO_ADMIN_TOTP_ACTIVE_KEY_VERSION',
    'FOLIO_WEB_AUTH_MODE','FOLIO_WEB_AUTH_ORIGIN','FOLIO_WEB_CSRF_KEY_HEX',
  ];
  const originals=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const temp=mkdtempSync(join(tmpdir(),'folio-mfa-https-'));
  const {db,pool}=createFolioDb(url);
  let httpsApp:INestApplication|undefined,httpApp:INestApplication|undefined;
  try{
    const password='Synthetic-Folio-Admin-TOTP-HTTPS-2026!';
    async function user(){
      const email='mfa-https-'+randomUUID()+'@example.com';
      const account=await registerPendingAccount(db,email,password);
      await verifyAccountEmail(db,account.verificationToken);
      return {...account,email};
    }
    const web=await user(),native=await user(),
      upgraded=await user(),unrelated=await user();
    for(const account of [web,native,upgraded]){
      await db.insert(schema.adminRoleMemberships).values({
        userId:account.userId,role:'rights',grantedBy:unrelated.userId,
      }); // Synthetic lab-only grant, no real admin bootstrap.
    }
    const webSession=await signInVerifiedAccount(db,web.email,password,'web-https-factor');
    const nativeSession=await signInVerifiedAccount(db,native.email,password,'android-factor');
    const upgradedSession=await signInVerifiedAccount(db,upgraded.email,password,'v2-factor');
    const regularSession=await signInVerifiedAccount(db,unrelated.email,password,'regular');

    process.env.FOLIO_ADMIN_TOTP_HTTP_MODE='off';
    process.env.FOLIO_ADMIN_TOTP_KEY_HEX=randomBytes(32).toString('hex');
    const cert=join(temp,'cert.pem'),key=join(temp,'key.pem');
    execFileSync('openssl',[
      'req','-new','-x509','-newkey','rsa:2048','-nodes',
      '-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost',
    ],{stdio:'ignore'});
    httpApp=await NestFactory.create(AppModule,{logger:false});
    httpApp.useGlobalFilters(new ApiExceptionFilter());
    const plainServer=await httpApp.listen(0,'127.0.0.1');
    const plainAddress=plainServer.address();
    if(!plainAddress||typeof plainAddress==='string')throw Error('No plain loopback port');
    const plainPort=plainAddress.port;
    httpsApp=await NestFactory.create(AppModule,{
      logger:false,httpsOptions:{key:readFileSync(key),cert:readFileSync(cert)},
    });
    httpsApp.useGlobalFilters(new ApiExceptionFilter());
    SwaggerModule.setup('openapi',httpsApp,createOpenApiDocument(httpsApp));
    const secureServer=await httpsApp.listen(0,'127.0.0.1');
    const secureAddress=secureServer.address();
    if(!secureAddress||typeof secureAddress==='string')throw Error('No TLS port');
    const port=secureAddress.port,origin='https://127.0.0.1:'+port;
    const root='/v1/admin/mfa/totp',csrfPath='/v1/auth/web/csrf';
    const cookie='__Host-folio_session='+webSession.sessionToken;
    const bearer={authorization:'Bearer '+nativeSession.sessionToken};

    const closed=await call(true,port,root+'/enroll','POST',bearer,{});
    check(closed.status===404&&closed.headers['cache-control']==='private, no-store',
      'Default-off admin MFA route was visible or cacheable');
    process.env.FOLIO_ADMIN_TOTP_HTTP_MODE='direct-tls-only';
    const forgedTls=await call(false,plainPort,root+'/enroll','POST',{
      ...bearer,'x-forwarded-proto':'https',
    },{});
    check(forgedTls.status===503&&
      forgedTls.headers['cache-control']==='private, no-store',
      'Forwarded TLS claim enabled plaintext factor secret endpoint');

    const malicious=await call(true,port,root+'/enroll','POST',{
      'x-user-id':web.userId,'x-admin-role':'superadmin','x-request-id':'client-chosen',
    },{});
    check(malicious.status===401,'Spoofed principal created TOTP enrollment');
    const spoofError=apiErrorSchema.parse(JSON.parse(malicious.body));
    check(spoofError.error.requestId===malicious.headers['x-request-id'],
      'Admin MFA denial omitted genuine server-side request correlation');
    const unavailableKey=process.env.FOLIO_ADMIN_TOTP_KEY_HEX;
    delete process.env.FOLIO_ADMIN_TOTP_KEY_HEX;
    check((await call(true,port,root+'/enroll','POST',bearer,{})).status===503,
      'Missing server-only encryption key permitted enrollment');
    process.env.FOLIO_ADMIN_TOTP_KEY_HEX=unavailableKey;
    const ordinary=await call(true,port,root+'/enroll','POST',{
      authorization:'Bearer '+regularSession.sessionToken,
    },{});
    check(ordinary.status===401,'Nonadmin registered a privileged factor');
    check((await call(true,port,root+'/enroll?userId='+web.userId,
      'POST',bearer,{})).status===400,
      'Caller-controlled admin subject in query was accepted');
    check((await call(true,port,root+'/enroll','POST',bearer,{
      userId:web.userId,
    })).status===400,'Caller-controlled account field accepted');
    check((await call(true,port,root+'/enroll','POST',{
      ...bearer,origin:'https://evil.example',
    },{})).status===401,'Browser bearer bypassed HttpOnly cookie policy');

    process.env.FOLIO_WEB_AUTH_MODE='direct-tls-only';
    process.env.FOLIO_WEB_AUTH_ORIGIN=origin;
    process.env.FOLIO_WEB_CSRF_KEY_HEX=randomBytes(32).toString('hex');
    const webHeaders={cookie,'sec-fetch-site':'same-origin',origin,
      'x-admin-role':'superadmin','x-user-id':unrelated.userId,
      'x-request-id':'spoofed-http-correlation'};
    check((await call(true,port,root+'/enroll','POST',webHeaders,{})).status===403,
      'Cookie admin TOTP enrollment accepted without CSRF');
    check((await call(true,port,root+'/enroll','POST',{
      ...webHeaders,origin:'https://evil.example','sec-fetch-site':'cross-site',
    },{})).status===403,
      'Cross-origin cookie factor enrollment accepted');
    check((await call(true,port,root+'/enroll','POST',{
      ...webHeaders,authorization:'Bearer '+nativeSession.sessionToken,
    },{})).status===401,
      'Cookie and native bearer crossover exposed MFA seed');
    const bootstrap=await call(true,port,csrfPath,'GET',webHeaders);
    const csrf=bootstrap.headers['x-folio-csrf'];
    check(bootstrap.status===204&&typeof csrf==='string',
      'Existing HTTPS web CSRF token bootstrap unavailable');
    const authorized={...webHeaders,'x-folio-csrf':csrf};
    const enrolled=await call(true,port,root+'/enroll','POST',authorized,{});
    check(enrolled.status===200&&
      enrolled.headers['cache-control']==='private, no-store'&&
      !enrolled.headers['set-cookie'],
      'Authorized cookie enrollment did not return secure uncached secret');
    const created=adminTotpEnrollResponseSchema.parse(JSON.parse(enrolled.body));
    check(enrolled.headers['x-request-id']!=='spoofed-http-correlation',
      'Client request ID influenced MFA auditing');
    check(!enrolled.body.includes(web.email)&&
      !enrolled.body.includes(webSession.sessionToken),
      'Secret response leaked account identity or raw bearer');
    const wrongBody=await call(true,port,root+'/confirm','POST',authorized,{
      code:'123456',userId:unrelated.userId,
    });
    check(wrongBody.status===400,'OTP body allowed an untrusted owner field');
    check((await call(true,port,root+'/confirm','POST',{
      ...webHeaders,'x-folio-csrf':'A'.repeat(43),
    },{code:'123456'})).status===403,'Forged HMAC-CSRF confirmed MFA');

    const confirmStep=Math.floor(Date.now()/30_000);
    const confirmed=await call(true,port,root+'/confirm','POST',authorized,{
      code:totpCode(created.secretBase32,confirmStep),
    });
    check(confirmed.status===204,'Real HTTPS CSRF TOTP factor confirmation failed');
    const freshStep=Math.max(confirmStep+1,Math.floor(Date.now()/30_000));
    const verified=await call(true,port,root+'/verify','POST',authorized,{
      code:totpCode(created.secretBase32,freshStep),
    });
    check(verified.status===200&&
      verified.headers['cache-control']==='private, no-store',
      'Same-origin cookie TOTP step-up failed');
    const result=adminTotpVerifyResponseSchema.parse(JSON.parse(verified.body));
    check(result.verified,'MFA proof schema did not confirm verification');
    check(await withVerifiedAdminPermission(db,webSession.sessionToken,
      'rights:review',async()=>true),
      'HTTPS cookie TOTP proof did not bind to owning session');
    check((await call(true,port,root+'/verify','POST',authorized,{
      code:totpCode(created.secretBase32,freshStep),
    })).status===401,'HTTP TOTP verification accepted a replayed code');
    check((await call(true,port,root+'/verify','POST',authorized,{
      code:'invalid',
    })).status===400,'Malformed HTTP OTP was not rejected');

    const nativeEnroll=await call(true,port,root+'/enroll','POST',bearer,{});
    check(nativeEnroll.status===200,'Verified native TLS bearer cannot enroll MFA');
    const mobileFactor=adminTotpEnrollResponseSchema.parse(JSON.parse(nativeEnroll.body));
    const nativeStep=Math.floor(Date.now()/30_000);
    check((await call(true,port,root+'/confirm','POST',bearer,{
      code:totpCode(mobileFactor.secretBase32,nativeStep),
    })).status===204,'Native TLS bearer failed real TOTP confirmation');
    check((await call(true,port,root+'/verify','POST',bearer,{
      code:totpCode(mobileFactor.secretBase32,
        Math.max(nativeStep+1,Math.floor(Date.now()/30_000))),
    })).status===200,'Native bearer failed its own MFA proof');
    check(await withVerifiedAdminPermission(db,nativeSession.sessionToken,
      'rights:review',async()=>true),
      'Native MFA verified wrong device');
    // Backward-compatible staged v2 encryption, with explicit configuration.
    // Existing v1 factors remain readable while both keys are present.
    process.env.FOLIO_ADMIN_TOTP_ACTIVE_KEY_VERSION='v2';
    delete process.env.FOLIO_ADMIN_TOTP_V2_KEY_HEX;
    const v2Bearer={authorization:'Bearer '+upgradedSession.sessionToken};
    check((await call(true,port,root+'/enroll','POST',v2Bearer,{})).status===503,
      'Selected v2 without a server key did not fail closed');
    process.env.FOLIO_ADMIN_TOTP_V2_KEY_HEX=process.env.FOLIO_ADMIN_TOTP_KEY_HEX;
    check((await call(true,port,root+'/enroll','POST',v2Bearer,{})).status===503,
      'Reused v1 key masqueraded as independent v2 key');
    process.env.FOLIO_ADMIN_TOTP_V2_KEY_HEX=randomBytes(32).toString('hex');
    const newFactor=await call(true,port,root+'/enroll','POST',v2Bearer,{});
    check(newFactor.status===200,'Explicit v2 enrollment could not run on TLS');
    const v2Enrollment=adminTotpEnrollResponseSchema.parse(JSON.parse(newFactor.body));
    const [v2Row]=await db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,upgraded.userId));
    check(v2Row?.keyVersion==='v2',
      'New v2 active-key enrollment persisted an incorrect key version');
    const v2Step=Math.floor(Date.now()/30_000);
    check((await call(true,port,root+'/confirm','POST',v2Bearer,{
      code:totpCode(v2Enrollment.secretBase32,v2Step),
    })).status===204,'New v2 factor failed RFC6238 enrollment confirmation');
    check((await call(true,port,root+'/verify','POST',v2Bearer,{
      code:totpCode(v2Enrollment.secretBase32,
        Math.max(v2Step+1,Math.floor(Date.now()/30_000))),
    })).status===200,'New v2 factor could not produce valid device proof');
    check(await withVerifiedAdminPermission(db,upgradedSession.sessionToken,
      'rights:review',async()=>true),
      'Verified v2 factor did not authorize matching device');

    const audit=await db.select().from(schema.auditEvents);
    const relevant=audit.filter(x=>[web.userId,native.userId,upgraded.userId]
      .includes(x.actorId??'')&&
      x.action.startsWith('admin.'));
    check(relevant.filter(x=>x.action==='admin.totp.enrollment.started').length===3&&
      relevant.filter(x=>x.action==='admin.totp.enrollment.confirmed').length===3&&
      relevant.filter(x=>x.action==='admin.mfa.totp.verified').length===3,
      'HTTP MFA audit events were not exactly one per actual mutation');
    const secretFree=JSON.stringify(relevant);
    for(const item of [
      created.secretBase32,mobileFactor.secretBase32,v2Enrollment.secretBase32,
      webSession.sessionToken,nativeSession.sessionToken,
      upgradedSession.sessionToken,password,
      process.env.FOLIO_ADMIN_TOTP_V2_KEY_HEX,
    ]){
      check(!secretFree.includes(item),'Raw MFA secret or token leaked to audit');
    }
    process.env.FOLIO_ADMIN_TOTP_HTTP_MODE='off';
    check((await call(true,port,root+'/verify','POST',authorized,{
      code:'123456',
    })).status===404,'Feature flag disable left HTTP MFA verification exposed');
    const openapi=await call(true,port,'/openapi-json','GET');
    check(openapi.status===200,'Real TLS OpenAPI endpoint missing');
    const spec=JSON.parse(openapi.body) as {
      paths:Record<string,Record<string,unknown>>;
    };
    check(!!spec.paths[root+'/enroll']?.post&&
      !!spec.paths[root+'/confirm']?.post&&
      !!spec.paths[root+'/verify']?.post,
      'Real opt-in MFA endpoints missing from OpenAPI');
    console.log('ADMIN TOTP HTTPS PASS: staged v1/v2 server keyring, missing/duplicate v2 503, new v2 real proof, default 404, no proxy TLS spoof, 503 missing key, same-origin CSRF cookie and separate native bearer, strict DTO/owner denies, encrypted live RFC6238 confirm+15m proof, replay 401, no-cache error/secret audit, feature gate off. Folio test DB only.');
  }finally{
    if(httpsApp)await httpsApp.close();
    if(httpApp)await httpApp.close();
    await pool.end();
    for(const key of keys){
      if(originals[key]===undefined)delete process.env[key];
      else process.env[key]=originals[key];
    }
    rmSync(temp,{recursive:true,force:true});
  }
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
