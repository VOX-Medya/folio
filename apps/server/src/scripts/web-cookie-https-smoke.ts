import 'reflect-metadata';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {request as httpsRequest} from 'node:https';
import type {IncomingHttpHeaders} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  Controller,Get,HttpCode,Inject,MiddlewareConsumer,Module,
  NestModule,Post,Req,Res,
} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {
  authenticateUserSession,createFolioDb,registerPendingAccount,
  revokeUserSession,signInVerifiedAccount,verifyAccountEmail,
} from '@folio/db';
import {apiErrorSchema} from '@folio/contracts';
import type {BearerSessionLookup} from '../common/session-auth.js';
import {ApiExceptionFilter,RequestIdMiddleware} from '../common/http.js';
import {
  issueWebSessionCookie,verifyWebCookieSession,webSessionCsrfToken,
} from '../common/web-cookie-session.js';
import type {WebCookiePolicy,WebCookieRequest} from '../common/web-cookie-session.js';
import {createFolioApp} from '../main.js';

const STATE=Symbol('folio.synthetic.web.cookie.test.state');
interface SmokeState {
  bearer:string;
  userId:string;
  lookup:BearerSessionLookup;
  policy:WebCookiePolicy;
}
interface SmokeResponse {setHeader(name:string,value:string):void;}
interface WireResult {status:number;headers:IncomingHttpHeaders;body:string;}
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}

@Controller('v1/_web-cookie-test')
class WebCookieTestController {
  constructor(@Inject(STATE) private readonly state:SmokeState){}
  // Test harness only: the bearer is a trusted in-memory fixture,
  // never an HTTP body or header input. NO production login route.
  @Post('issue')
  @HttpCode(200)
  async issue(@Req() request:WebCookieRequest,@Res({passthrough:true}) response:SmokeResponse){
    const principal=await this.state.lookup(this.state.bearer);
    if(!principal||principal.userId!==this.state.userId){
      throw new Error('Unverified synthetic fixture');
    }
    response.setHeader('Set-Cookie',
      issueWebSessionCookie(request,this.state.bearer,this.state.policy));
    response.setHeader('Cache-Control','private, no-store');
    return {issued:true};
  }
  @Get('csrf')
  async bootstrap(@Req() request:WebCookieRequest,@Res({passthrough:true}) response:SmokeResponse){
    const principal=await verifyWebCookieSession(
      request,this.state.lookup,this.state.policy,'GET');
    response.setHeader('Cache-Control','private, no-store');
    response.setHeader('X-Folio-CSRF',
      await webSessionCsrfToken(request,this.state.lookup,this.state.policy));
    return {userId:principal.userId};
  }
  @Post('mutate')
  @HttpCode(200)
  async mutate(@Req() request:WebCookieRequest,@Res({passthrough:true}) response:SmokeResponse){
    const principal=await verifyWebCookieSession(
      request,this.state.lookup,this.state.policy,'POST');
    response.setHeader('Cache-Control','private, no-store');
    return {accepted:principal.userId===this.state.userId};
  }
}

async function httpsCall(port:number,path:string,method:string,headers:Record<string,string>={}):
 Promise<WireResult> {
  return new Promise<WireResult>((resolve,reject)=>{
    // Only the ephemeral, loopback, self-signed test certificate is exempted
    // from verification. No global TLS environment changes or real network.
    const req=httpsRequest({
      host:'127.0.0.1',port,path,method,headers,rejectUnauthorized:false,timeout:10000,
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
    req.on('timeout',()=>req.destroy(new Error('HTTPS smoke timeout')));
    req.end();
  });
}

async function main(){
  const dbUrl=process.env.DATABASE_URL;
  if(!dbUrl)throw Error('Explicit Folio test DB URL required');
  const u=new URL(dbUrl);
  if(u.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(u.hostname)||
     u.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw Error('Web cookie smoke only accepts isolated Folio folio_test DB');
  }
  const {db,pool}=createFolioDb(dbUrl);
  const scratch=mkdtempSync(join(tmpdir(),'folio-web-tls-'));
  let tlsApp:Awaited<ReturnType<typeof NestFactory.create>>|undefined;
  let plainApp:Awaited<ReturnType<typeof NestFactory.create>>|undefined;
  let productionApp:Awaited<ReturnType<typeof createFolioApp>>|undefined;
  try{
    const email='synthetic-web-cookie-'+randomUUID()+'@example.com';
    const password='Synthetic-Web-CSRF-2026-Strong!';
    const pending=await registerPendingAccount(db,email,password);
    await verifyAccountEmail(db,pending.verificationToken);
    const signed=await signInVerifiedAccount(db,email,password,'web');
    const state:SmokeState={
      bearer:signed.sessionToken,userId:pending.userId,
      lookup:(bearer:string)=>authenticateUserSession(db,bearer),
      policy:{origin:undefined,csrfKeyHex:'c'.repeat(64)},
    };
    @Module({
      controllers:[WebCookieTestController],
      providers:[{provide:STATE,useValue:state}],
    })
    class TestOnlyModule implements NestModule {
      configure(consumer:MiddlewareConsumer):void{
        consumer.apply(RequestIdMiddleware).forRoutes('*');
      }
    }
    const key=join(scratch,'key.pem'),cert=join(scratch,'cert.pem');
    execFileSync('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes',
      '-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
    tlsApp=await NestFactory.create(TestOnlyModule,{
      logger:false,httpsOptions:{key:readFileSync(key),cert:readFileSync(cert)},
    });
    tlsApp.useGlobalFilters(new ApiExceptionFilter());
    const server=await tlsApp.listen(0,'127.0.0.1');
    const address=server.address();
    if(!address||typeof address==='string')throw Error('Missing HTTPS loopback port');
    const port=address.port,origin='https://127.0.0.1:'+port;
    state.policy.origin=origin;
    const prefix='/v1/_web-cookie-test';
    const issued=await httpsCall(port,prefix+'/issue','POST',{
      origin,'sec-fetch-site':'same-origin','x-forwarded-proto':'http',
    });
    check(issued.status===200,'Verified test HTTPS cookie issuance failed');
    const setCookie=issued.headers['set-cookie']?.[0];
    check(typeof setCookie==='string','Missing test cookie');
    check(setCookie.includes('Secure')&&setCookie.includes('HttpOnly')&&
      setCookie.includes('SameSite=Strict')&&setCookie.includes('Path=/')&&
      !setCookie.includes('Domain='),'Cookie not host-only and secure');
    check(!issued.body.includes(signed.sessionToken),'Bearer leaked in JSON');
    const cookie=setCookie.split(';')[0];
    check(!!cookie,'Cookie fixture missing');
    const boot=await httpsCall(port,prefix+'/csrf','GET',{
      cookie,'x-user-id':'fake','x-admin-role':'superadmin',
    });
    check(boot.status===200,'HTTPS cookie could not bootstrap CSRF');
    const csrf=boot.headers['x-folio-csrf'];
    check(typeof csrf==='string'&&/^[A-Za-z0-9_-]{43}$/.test(csrf),
      'No valid server-generated CSRF token');
    check(JSON.parse(boot.body).userId===pending.userId,
      'Spoofed principal affected identity');
    const allowed={cookie,origin,'sec-fetch-site':'same-origin','x-folio-csrf':csrf};
    const okay=await httpsCall(port,prefix+'/mutate','POST',allowed);
    check(okay.status===200&&JSON.parse(okay.body).accepted===true,
      'TLS + Origin + CSRF verified mutation failed');
    check(okay.headers['cache-control']==='private, no-store','Private response cacheable');

    for(const bad of [
      {cookie,origin:'https://attacker.example','x-folio-csrf':csrf},
      {cookie,'x-folio-csrf':csrf,'x-forwarded-proto':'https'},
      {...allowed,'sec-fetch-site':'cross-site'},
      {...allowed,'x-folio-csrf':'x'.repeat(43)},
    ]){
      const denied=await httpsCall(port,prefix+'/mutate','POST',bad);
      check(denied.status===403,'Cross-origin or bad CSRF mutation accepted');
      const error=apiErrorSchema.parse(JSON.parse(denied.body));
      check(error.error.requestId===denied.headers['x-request-id'],
        '403 response lost server request ID');
    }
    check((await httpsCall(port,prefix+'/csrf','GET',{
      authorization:'Bearer '+signed.sessionToken,
    })).status===401,'Native bearer used instead of cookie');
    check((await httpsCall(port,prefix+'/csrf','GET',{
      cookie:cookie+'; '+cookie,
    })).status===401,'Duplicate cookie accepted');

    plainApp=await NestFactory.create(TestOnlyModule,{logger:false});
    plainApp.useGlobalFilters(new ApiExceptionFilter());
    const plainServer=await plainApp.listen(0,'127.0.0.1');
    const plainAddress=plainServer.address();
    if(!plainAddress||typeof plainAddress==='string')throw Error('No plain HTTP port');
    const plain=await fetch('http://127.0.0.1:'+plainAddress.port+prefix+'/issue',{
      method:'POST',headers:{origin,'sec-fetch-site':'same-origin',
        'x-forwarded-proto':'https'},
    });
    check(plain.status===503&&!plain.headers.has('set-cookie'),
      'Forged proxy TLS header enabled plaintext cookie issuance');

    check((await revokeUserSession(db,signed.sessionToken)).revoked,
      'Synthetic revoke failed');
    check((await httpsCall(port,prefix+'/csrf','GET',{cookie})).status===401,
      'Revoked cookie remained valid');

    productionApp=await createFolioApp();
    const live=await productionApp.listen(0,'127.0.0.1');
    const liveAddress=live.address();
    if(!liveAddress||typeof liveAddress==='string')throw Error('Missing live port');
    const root='http://127.0.0.1:'+liveAddress.port;
    check((await fetch(root+prefix+'/issue',{method:'POST'})).status===404,
      'Test cookie route exposed in production AppModule');
    const spec=await (await fetch(root+'/openapi-json')).json() as {
      paths:Record<string,unknown>;
    };
    check(!Object.keys(spec.paths).some(path=>path.includes('_web-cookie-test')),
      'Test cookie route exposed in OpenAPI');
    console.log('WEB COOKIE HTTPS PASS: real TLS host-only cookie, strict Origin+CSRF, HTTP proxy spoof refused, no native bearer crossover, revoked session denied, no production routes. Folio synthetic DB only.');
  }finally{
    if(productionApp)await productionApp.close();
    if(plainApp)await plainApp.close();
    if(tlsApp)await tlsApp.close();
    await pool.end();
    rmSync(scratch,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
