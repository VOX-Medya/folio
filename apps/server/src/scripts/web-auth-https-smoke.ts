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
  createFolioDb,registerPendingAccount,verifyAccountEmail,
} from '@folio/db';
import {apiErrorSchema} from '@folio/contracts';
import {AppModule,ApiExceptionFilter,createFolioApp,createOpenApiDocument} from '../main.js';

interface HttpResult{status:number;headers:IncomingHttpHeaders;body:string;}
const runtimeKeys=[
  'FOLIO_WEB_AUTH_MODE','FOLIO_WEB_AUTH_ORIGIN','FOLIO_WEB_CSRF_KEY_HEX',
  'FOLIO_AUTH_ABUSE_HMAC_KEY_HEX',
] as const;
function check(x:unknown,message:string):asserts x{if(!x)throw Error(message);}
async function httpsCall(
  port:number,path:string,method:string,headers:Record<string,string>={},
  payload?:unknown,
):Promise<HttpResult>{
  const json=payload===undefined?undefined:JSON.stringify(payload);
  const requestHeaders={...headers,
    ...(json!==undefined?{'content-type':'application/json',
      'content-length':String(Buffer.byteLength(json))}:{})
  };
  return new Promise<HttpResult>((resolve,reject)=>{
    // Scoped to the newly minted ephemeral localhost test certificate.
    // There is NO global TLS bypass and no external hostname.
    const req=httpsRequest({
      host:'127.0.0.1',port,path,method,headers:requestHeaders,
      rejectUnauthorized:false,timeout:10000,
    },response=>{
      const bytes:Buffer[]=[];
      response.on('data',(chunk:Buffer)=>bytes.push(chunk));
      response.on('end',()=>resolve({
        status:response.statusCode??0,headers:response.headers,
        body:Buffer.concat(bytes).toString('utf8'),
      }));
      response.on('error',reject);
    });
    req.on('error',reject);
    req.on('timeout',()=>req.destroy(new Error('Folio HTTPS smoke timeout')));
    req.end(json);
  });
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw Error('Explicit isolated Folio test database required');
  const dbUrl=new URL(url);
  if(dbUrl.pathname!=='/folio_test'||
     !['127.0.0.1','localhost'].includes(dbUrl.hostname)||
     dbUrl.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw Error('Web auth smoke is restricted to local Folio folio_test DB');
  }
  const originals=Object.fromEntries(runtimeKeys.map(key=>[key,process.env[key]]));
  const scratch=mkdtempSync(join(tmpdir(),'folio-web-auth-'));
  const {db,pool}=createFolioDb(url);
  let httpApp:INestApplication|undefined;
  let httpsApp:INestApplication|undefined;
  try{
    const email='synthetic-web-auth-'+randomUUID()+'@example.com';
    const password='Synthetic-Folio-Web-Login-2026!';
    const pending=await registerPendingAccount(db,email,password);
    await verifyAccountEmail(db,pending.verificationToken);
    const validBody={email,password};
    const root='/v1/auth/web';
    // A production-style AppModule on plain HTTP must deny all login,
    // regardless of caller-provided proxy headers or prior user records.
    delete process.env.FOLIO_WEB_AUTH_MODE;
    httpApp=await createFolioApp();
    const plainServer=await httpApp.listen(0,'127.0.0.1');
    const plainAddress=plainServer.address();
    if(!plainAddress||typeof plainAddress==='string')throw Error('Missing plain HTTP port');
    const plainUrl='http://127.0.0.1:'+plainAddress.port+root+'/login';
    const closed=await fetch(plainUrl,{method:'POST',headers:{
      'content-type':'application/json',
    },body:JSON.stringify(validBody)});
    check(closed.status===404,'Disabled web authentication unexpectedly exposed a login route');
    check(closed.headers.get('cache-control')?.includes('no-store'),
      'Disabled auth route response is cacheable');

    const keyFile=join(scratch,'key.pem'),certFile=join(scratch,'cert.pem');
    execFileSync('openssl',[
      'req','-new','-x509','-newkey','rsa:2048','-nodes',
      '-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=localhost',
    ],{stdio:'ignore'});
    httpsApp=await NestFactory.create(AppModule,{
      logger:false,httpsOptions:{
        key:readFileSync(keyFile),cert:readFileSync(certFile),
      },
    });
    httpsApp.useGlobalFilters(new ApiExceptionFilter());
    SwaggerModule.setup('openapi',httpsApp,createOpenApiDocument(httpsApp));
    const secureServer=await httpsApp.listen(0,'127.0.0.1');
    const secureAddress=secureServer.address();
    if(!secureAddress||typeof secureAddress==='string')throw Error('Missing ephemeral HTTPS port');
    const port=secureAddress.port,origin='https://127.0.0.1:'+port;
    process.env.FOLIO_WEB_AUTH_MODE='direct-tls-only';
    process.env.FOLIO_WEB_AUTH_ORIGIN=origin;
    process.env.FOLIO_WEB_CSRF_KEY_HEX='b'.repeat(64); // Synthetic test key, not production
    process.env.FOLIO_AUTH_ABUSE_HMAC_KEY_HEX='c'.repeat(64); // Synthetic test key

    const sameOrigin={origin,'sec-fetch-site':'same-origin'};
    const plain=await fetch(plainUrl,{
      method:'POST',headers:{...sameOrigin,'x-forwarded-proto':'https',
        'content-type':'application/json'},
      body:JSON.stringify(validBody),
    });
    check(plain.status===503&&!plain.headers.has('set-cookie'),
      'Spoofed X-Forwarded-Proto enabled plaintext web login');

    const wrongOrigin=await httpsCall(port,root+'/login','POST',{
      origin:'https://evil.example','sec-fetch-site':'cross-site',
    },validBody);
    check(wrongOrigin.status===403&&!wrongOrigin.headers['set-cookie'],
      'Cross-origin login set a session cookie');

    const crossover=await httpsCall(port,root+'/login','POST',{
      ...sameOrigin,authorization:'Bearer '+'A'.repeat(43),
    },validBody);
    check(crossover.status===401,'Bearer+web login crossover accepted');
    const oldCookie=await httpsCall(port,root+'/login','POST',{
      ...sameOrigin,cookie:'__Host-folio_session='+'A'.repeat(43),
    },validBody);
    check(oldCookie.status===401,'Session fixation cookie accepted on login');

    const badPassword=await httpsCall(port,root+'/login','POST',sameOrigin,{
      email,password:'A-Different-Strong-Password-2026!',
    });
    const unknown=await httpsCall(port,root+'/login','POST',sameOrigin,{
      email:'missing-'+randomUUID()+'@example.com',password,
    });
    check(badPassword.status===401&&unknown.status===401,
      'Invalid credentials or missing account disclosed account existence');
    const failOne=apiErrorSchema.parse(JSON.parse(badPassword.body));
    const failTwo=apiErrorSchema.parse(JSON.parse(unknown.body));
    check(failOne.error.message===failTwo.error.message &&
      failOne.error.code==='UNAUTHORIZED','Account enumeration via login error messages');

    const good=await httpsCall(port,root+'/login','POST',{
      ...sameOrigin,'x-forwarded-for':'198.51.100.245',
      'x-forwarded-proto':'http','x-user-id':'another-user',
      'x-admin-role':'superadmin',
    },validBody);
    check(good.status===204&&good.body===''&&
      good.headers['cache-control']==='private, no-store',
      'Web login must return empty 204 and private no-store');
    const setCookie=good.headers['set-cookie']?.[0];
    check(typeof setCookie==='string'&&setCookie.includes('__Host-folio_session=')&&
      setCookie.includes('Secure')&&setCookie.includes('HttpOnly')&&
      setCookie.includes('SameSite=Strict')&&
      setCookie.includes('Path=/')&&!setCookie.includes('Domain='),
      'Web session cookie flags are unsafe');
    const cookie=setCookie.split(';')[0];
    check(!!cookie&&cookie.length>60,'No bearer cookie after verified login');
    check(!good.body.includes(cookie)&&!badPassword.body.includes(password),
      'Bearer/password leaked into HTTP JSON');

    const csrfGet=await httpsCall(port,root+'/csrf','GET',{
      cookie,'sec-fetch-site':'same-origin',
    });
    const csrf=csrfGet.headers['x-folio-csrf'];
    check(csrfGet.status===204&&typeof csrf==='string'&&
      /^[A-Za-z0-9_-]{43}$/.test(csrf)&&csrfGet.body==='',
      'Verified cookie could not bootstrap CSRF');
    check((await httpsCall(port,root+'/csrf','GET',{cookie})).status===403,
      'CSRF bootstrap without Origin or Fetch Metadata was accepted');
    check((await httpsCall(port,root+'/csrf','GET',{
      cookie,'sec-fetch-site':'cross-site',
    })).status===403,'Cross-site CSRF bootstrap accepted');
    check((await httpsCall(port,root+'/logout','POST',{
      cookie,origin,'sec-fetch-site':'same-origin',
    })).status===403,'Cookie logout without CSRF token accepted');
    check((await httpsCall(port,root+'/logout','POST',{
      cookie,origin,'sec-fetch-site':'same-origin',
      'x-folio-csrf':'A'.repeat(43),
    })).status===403,'Invalid CSRF token accepted');

    const logout=await httpsCall(port,root+'/logout','POST',{
      cookie,origin,'sec-fetch-site':'same-origin','x-folio-csrf':csrf,
    });
    check(logout.status===204&&logout.headers['set-cookie']?.[0]?.includes('Max-Age=0'),
      'Verified web logout did not clear the secure cookie');
    const retired=await httpsCall(port,root+'/csrf','GET',{
      cookie,'sec-fetch-site':'same-origin',
    });
    check(retired.status===401&&
      retired.headers['set-cookie']?.[0]?.includes('Max-Age=0')&&
      retired.headers['set-cookie']?.[0]?.includes('HttpOnly')&&
      retired.headers['set-cookie']?.[0]?.includes('Secure')&&
      !retired.headers['x-folio-csrf'],
      'Revoked browser cookie was not securely retired on same-origin bootstrap');
    const crossSiteRevoked=await httpsCall(port,root+'/csrf','GET',{
      cookie,origin:'https://evil.example','sec-fetch-site':'cross-site',
    });
    check(crossSiteRevoked.status===403&&!crossSiteRevoked.headers['set-cookie'],
      'Cross-site request retired a cookie without same-origin proof');
    const headerlessRevoked=await httpsCall(port,root+'/csrf','GET',{cookie});
    check(headerlessRevoked.status===403&&!headerlessRevoked.headers['set-cookie'],
      'Headerless CSRF bootstrap retired a cookie');

    // Two accepted account attempts above (bad password + successful sign-in).
    // Three further invalid password attempts fill its 5-per-15m account quota.
    for(let i=0;i<3;i++){
      check((await httpsCall(port,root+'/login','POST',sameOrigin,{
        email,password:'Another-Different-Secure-Password-2026!',
      })).status===401,'An invalid password bypassed generic auth failure');
    }
    const limited=await httpsCall(port,root+'/login','POST',{
      ...sameOrigin,'x-forwarded-for':'203.0.113.87',
    },validBody);
    check(limited.status===429&&limited.headers['retry-after']==='900'&&
      !limited.headers['set-cookie'],'Account rate limit must reject before password check');
    const limitedError=apiErrorSchema.parse(JSON.parse(limited.body));
    check(limitedError.error.code==='RATE_LIMITED'&&
      limitedError.error.requestId===limited.headers['x-request-id']&&
      !limited.body.includes(email),'Rate response leaked account or request ID');

    delete process.env.FOLIO_AUTH_ABUSE_HMAC_KEY_HEX;
    const noQuotaKey=await httpsCall(port,root+'/login','POST',sameOrigin,{
      email:'synthetic-missing-secret-'+randomUUID()+'@example.com',password,
    });
    check(noQuotaKey.status===503&&!noQuotaKey.headers['set-cookie'],
      'Missing rate-limit secret allowed a password check');
    delete process.env.FOLIO_WEB_CSRF_KEY_HEX;
    check((await httpsCall(port,root+'/login','POST',sameOrigin,validBody)).status===503,
      'Missing CSRF key allowed sign-in');
    const audit=await pool.query<{action:string;after_json:unknown}>(
      'SELECT action,after_json FROM audit_events WHERE actor_id=$1::uuid',
      [pending.userId],
    );
    check(audit.rows.filter(x=>x.action==='auth.session.created').length===1&&
      audit.rows.filter(x=>x.action==='auth.session.revoked').length===1,
      'Rejected credential/CSRF attempts unexpectedly created or revoked sessions');
    const serialized=JSON.stringify(audit.rows);
    check(!serialized.includes(email)&&!serialized.includes(password)&&
      !serialized.includes(cookie),'Sensitive data leaked to auth audit');

    process.env.FOLIO_WEB_AUTH_MODE='off';
    check((await httpsCall(port,root+'/login','POST',sameOrigin,validBody)).status===404,
      'Feature gate did not fail closed after disabling opt-in');
    const specResponse=await httpsCall(port,'/openapi-json','GET');
    check(specResponse.status===200,'Real HTTPS OpenAPI document missing');
    const spec=JSON.parse(specResponse.body) as {
      paths:Record<string,Record<string,unknown>>;
    };
    check(!!spec.paths[root+'/login']?.post &&
      !!spec.paths[root+'/csrf']?.get &&
      !!spec.paths[root+'/logout']?.post,
      'Documented opt-in HTTP routes missing from OpenAPI');
    console.log('WEB AUTH HTTPS PASS: default 404, direct TLS+origin+quota verified login, 204 secure cookie, generic 401, 429 quota, HMAC CSRF bootstrap/logout, revoked 401, no credentials leaked, missing secrets 503, no HTTP forwarded-proto bypass. Synthetic Folio-only test DB.');
  }finally{
    if(httpsApp)await httpsApp.close();
    if(httpApp)await httpApp.close();
    await pool.end();
    for(const key of runtimeKeys){
      const old=originals[key];
      if(old===undefined)delete process.env[key];
      else process.env[key]=old;
    }
    rmSync(scratch,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
