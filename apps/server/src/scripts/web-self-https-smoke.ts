import 'reflect-metadata';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {request as httpsRequest} from 'node:https';
import type {IncomingHttpHeaders} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NestFactory} from '@nestjs/core';
import type {INestApplication} from '@nestjs/common';
import {SwaggerModule} from '@nestjs/swagger';
import {
  createFolioDb,registerPendingAccount,verifyAccountEmail,signInVerifiedAccount,
} from '@folio/db';
import {
  apiErrorSchema,deviceSessionInventorySchema,onboardingSnapshotSchema,
} from '@folio/contracts';
import {ApiExceptionFilter,AppModule,createFolioApp,createOpenApiDocument} from '../main.js';

interface Wire{status:number;headers:IncomingHttpHeaders;body:string;}
function check(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function headersWith(body:unknown,headers:Record<string,string>){
  const json=body===undefined?undefined:JSON.stringify(body);
  return {json,headers:{...headers,...(json===undefined?{}:{
    'content-type':'application/json','content-length':String(Buffer.byteLength(json)),
  })}};
}
async function call(port:number,path:string,method:string,
  headers:Record<string,string>={},body?:unknown):Promise<Wire>{
  const data=headersWith(body,headers);
  return new Promise((resolve,reject)=>{
    const req=httpsRequest({
      host:'127.0.0.1',port,path,method,headers:data.headers,
      // Only the one-time self-signed loopback fixture is exempted.
      rejectUnauthorized:false,timeout:10000,
    },res=>{
      const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>chunks.push(chunk));
      res.on('end',()=>resolve({
        status:res.statusCode??0,headers:res.headers,
        body:Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error',reject);
    });
    req.on('error',reject);
    req.on('timeout',()=>req.destroy(Error('Folio HTTPS self-route smoke timeout')));
    req.end(data.json);
  });
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw Error('Explicit isolated Folio test database required');
  const u=new URL(url);
  if(u.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(u.hostname)||
     u.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw Error('Web self-route smoke can use only Folio folio_test on local PostgreSQL');
  }
  const names=[
    'FOLIO_WEB_AUTH_MODE','FOLIO_WEB_AUTH_ORIGIN',
    'FOLIO_WEB_CSRF_KEY_HEX','FOLIO_AUTH_ABUSE_HMAC_KEY_HEX',
  ];
  const originals=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const scratch=mkdtempSync(join(tmpdir(),'folio-self-web-'));
  const {db,pool}=createFolioDb(url);
  let app:INestApplication|undefined,plain:INestApplication|undefined;
  try{
    const pass='Synthetic-Web-Owner-2026-Strong!';
    async function account(){
      const email='synthetic-self-web-'+randomUUID()+'@example.com';
      const registered=await registerPendingAccount(db,email,pass);
      await verifyAccountEmail(db,registered.verificationToken);
      return {email,userId:registered.userId};
    }
    const first=await account(),unrelated=await account();
    const native=await signInVerifiedAccount(db,unrelated.email,pass,'android');
    const key=join(scratch,'key.pem'),cert=join(scratch,'cert.pem');
    execFileSync('openssl',[
      'req','-new','-x509','-newkey','rsa:2048','-nodes',
      '-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost',
    ],{stdio:'ignore'});
    app=await NestFactory.create(AppModule,{
      logger:false,httpsOptions:{key:readFileSync(key),cert:readFileSync(cert)},
    });
    app.useGlobalFilters(new ApiExceptionFilter());
    SwaggerModule.setup('openapi',app,createOpenApiDocument(app));
    const server=await app.listen(0,'127.0.0.1');
    const address=server.address();
    if(!address||typeof address==='string')throw Error('No HTTPS listener');
    const port=address.port,origin='https://127.0.0.1:'+port;
    process.env.FOLIO_WEB_AUTH_MODE='direct-tls-only';
    process.env.FOLIO_WEB_AUTH_ORIGIN=origin;
    process.env.FOLIO_WEB_CSRF_KEY_HEX='6'.repeat(64);
    process.env.FOLIO_AUTH_ABUSE_HMAC_KEY_HEX='7'.repeat(64);
    const auth='/v1/auth/web',onboarding='/v1/me/onboarding',sessions='/v1/me/sessions';
    const sameOrigin={origin,'sec-fetch-site':'same-origin'};
    const issued=await call(port,auth+'/login','POST',sameOrigin,{
      email:first.email,password:pass,
    });
    check(issued.status===204,'Opted-in TLS account could not log in');
    const setCookie=issued.headers['set-cookie']?.[0];
    check(typeof setCookie==='string'&&setCookie.startsWith('__Host-folio_session='),
      'Missing secure browser cookie after login');
    const cookie=setCookie.split(';')[0];
    check(!!cookie,'No session cookie');

    const nativeHeaders={authorization:'Bearer '+native.sessionToken};
    const nativeSnapshot=await call(port,onboarding,'GET',nativeHeaders);
    check(nativeSnapshot.status===200,'Native Authorization regressed');
    check(onboardingSnapshotSchema.parse(JSON.parse(nativeSnapshot.body)).userId===unrelated.userId,
      'Native bearer switched to a web owner');

    const webHeaders={cookie,'sec-fetch-site':'same-origin',
      'x-user-id':unrelated.userId,'x-admin-role':'superadmin'};
    const read=await call(port,onboarding,'GET',webHeaders);
    check(read.status===200&&read.headers['cache-control']==='private, no-store',
      'HttpOnly cookie could not read its owner onboarding');
    const snap=onboardingSnapshotSchema.parse(JSON.parse(read.body));
    check(snap.userId===first.userId&&snap.stage==='welcome'&&snap.version===0,
      'Forged headers selected a foreign onboarding owner');

    const cross=await call(port,onboarding,'GET',{cookie,origin:'https://evil.test'});
    check(cross.status===403,'Cross-site cookie GET was allowed');
    const crossError=apiErrorSchema.parse(JSON.parse(cross.body));
    check(crossError.error.code==='FORBIDDEN'&&
      crossError.error.requestId===cross.headers['x-request-id'],
      'CSRF origin denial lost trusted request ID');
    check((await call(port,onboarding,'GET',{cookie,'sec-fetch-site':'cross-site'})).status===403,
      'Cross-site Fetch Metadata cookie GET was allowed');
    check((await call(port,onboarding,'GET',{
      ...webHeaders,...nativeHeaders,
    })).status===401,'Cookie/Authorization crossover was allowed');

    const patch={expectedVersion:0,stage:'language',locale:'en',interests:[]};
    check((await call(port,onboarding,'PATCH',webHeaders,patch)).status===403,
      'Cookie PATCH without CSRF token succeeded');
    const csrfResponse=await call(port,auth+'/csrf','GET',webHeaders);
    const csrf=csrfResponse.headers['x-folio-csrf'];
    check(csrfResponse.status===204&&typeof csrf==='string'&&
      /^[A-Za-z0-9_-]{43}$/.test(csrf),
      'No CSRF bootstrap for cookie owner');
    const mutating={...webHeaders,origin,'x-folio-csrf':csrf};
    const saved=await call(port,onboarding,'PATCH',mutating,patch);
    check(saved.status===200,'Cookie session with CSRF could not save onboarding');
    const updated=onboardingSnapshotSchema.parse(JSON.parse(saved.body));
    check(updated.userId===first.userId&&updated.version===1&&updated.locale==='en',
      'Web session saved a foreign or incorrect onboarding snapshot');
    check((await call(port,onboarding,'PATCH',mutating,patch)).status===409,
      'Web cookie stale optimistic update was not rejected');
    check((await call(port,onboarding,'PATCH',mutating,{
      ...patch,expectedVersion:1,userId:unrelated.userId,
    })).status===400,'Caller-selected owner was accepted on cookie PATCH');

    const items=await call(port,sessions,'GET',webHeaders);
    check(items.status===200,'Web cookie cannot list owned sessions');
    const inventory=deviceSessionInventorySchema.parse(JSON.parse(items.body));
    check(inventory.items.length===1&&inventory.items[0]?.isCurrent===true,
      'Web inventory revealed a foreign session');
    const self=inventory.items[0]?.id;
    if(!self)throw Error('No web session ID');
    check((await call(port,sessions+'/'+self,'DELETE',webHeaders)).status===403,
      'Web cookie DELETE without CSRF was allowed');
    check((await call(port,sessions+'/'+native.sessionId,'DELETE',mutating)).status===404,
      'Web cookie could revoke a foreign user device');
    const deleted=await call(port,sessions+'/'+self,'DELETE',mutating);
    check(deleted.status===204,'CSRF verified web cookie could not revoke own device');
    check((await call(port,onboarding,'GET',webHeaders)).status===401,
      'Self-revoked web cookie still accessed private account data');
    const retired=await call(port,auth+'/csrf','GET',webHeaders);
    check(retired.status===401&&
      retired.headers['set-cookie']?.[0]?.includes('Max-Age=0')&&
      !retired.headers['x-folio-csrf'],
      'Remotely revoked session did not retire its HttpOnly cookie on bootstrap');
    check((await call(port,onboarding,'GET',nativeHeaders)).status===200,
      'Web self-revocation damaged unrelated native bearer');

    plain=await createFolioApp();
    const httpServer=await plain.listen(0,'127.0.0.1');
    const addr=httpServer.address();
    if(!addr||typeof addr==='string')throw Error('No HTTP listener');
    const plaintext=await fetch('http://127.0.0.1:'+addr.port+onboarding,{
      headers:{cookie,'x-forwarded-proto':'https','x-user-id':first.userId},
    });
    check(plaintext.status===503,'Unverified reverse-proxy TLS spoof allowed cookie access');
    process.env.FOLIO_WEB_AUTH_MODE='off';
    check((await call(port,onboarding,'GET',webHeaders)).status===401,
      'Disabled web cookie authentication remained enabled');
    check((await call(port,onboarding,'GET',nativeHeaders)).status===200,
      'Disabling web mode disabled native bearer authentication');

    const audit=await pool.query<{action:string;after_json:unknown}>(
      'SELECT action,after_json FROM audit_events WHERE actor_id=$1::uuid',
      [first.userId],
    );
    check(audit.rows.filter(row=>row.action==='user.onboarding.update').length===1&&
      audit.rows.filter(row=>row.action==='auth.session.revoked').length===1,
      'Rejected cookie mutations incorrectly generated audit events');
    check(!JSON.stringify(audit.rows).includes(cookie)&&
      !JSON.stringify(audit.rows).includes(pass),
      'Browser secrets leaked into audit log');
    const doc=await call(port,'/openapi-json','GET');
    const spec=JSON.parse(doc.body) as {
      components:{securitySchemes:Record<string,unknown>},
      paths:Record<string,Record<string,unknown>>,
    };
    check(!!spec.components.securitySchemes.folioSession&&
      !!spec.components.securitySchemes.folioWebSession&&
      !!spec.paths[onboarding]?.patch&&!!spec.paths[sessions+'/{sessionId}']?.delete,
      'Swagger omitted protected cookie-or-bearer self routes');
    console.log('WEB SELF COOKIE HTTPS PASS: direct TLS cookie owner onboarding GET/PATCH, CSRF 403, cross-site 403, stale 409, secure device listing and self DELETE, revoked 401, bearer remains independent, fake proxy TLS 503, disabled mode 401, audit isolation. Synthetic Folio DB only.');
  }finally{
    if(plain)await plain.close();
    if(app)await app.close();
    await pool.end();
    for(const name of names){
      const value=originals[name];
      if(value===undefined)delete process.env[name];
      else process.env[name]=value;
    }
    rmSync(scratch,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
