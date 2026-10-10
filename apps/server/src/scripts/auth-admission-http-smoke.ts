import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {
  Body,Controller,Get,HttpCode,Inject,MiddlewareConsumer,Module,
  NestModule,Post,Req,
} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {createFolioDb} from '@folio/db';
import {apiErrorSchema} from '@folio/contracts';
import {ApiExceptionFilter,RequestIdMiddleware} from '../common/http.js';
import {enforceTrustedSocketAuthAttempt} from '../common/trusted-auth-admission.js';
import type {PeerRequest} from '../common/trusted-auth-admission.js';
import {createFolioApp} from '../main.js';

const TOKEN=Symbol('folio.test.only.db');
const key='9'.repeat(64); // Synthetic smoke fixture, NEVER a production secret
type Db=ReturnType<typeof createFolioDb>['db'];
function check(v:unknown,message:string):asserts v{if(!v)throw new Error(message);}

@Controller('v1/_auth-admission-test')
class TestOnlyController {
  constructor(@Inject(TOKEN) private readonly db:Db){}
  @Post('attempt')
  @HttpCode(200)
  async admit(@Req() request:PeerRequest,@Body() body:unknown):Promise<{admitted:true}>{
    await enforceTrustedSocketAuthAttempt(this.db,request,body,key);
    return {admitted:true};
  }
  @Get('no-real-login')
  forbiddenExample():{warning:string}{
    return {warning:'Not a real auth endpoint'};
  }
}

async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio CI test database required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Auth admission HTTP smoke is restricted to the isolated Folio test DB');
  }
  const {db,pool}=createFolioDb(url);
  let app:Awaited<ReturnType<typeof NestFactory.create>>|undefined;
  let productionApp:Awaited<ReturnType<typeof createFolioApp>>|undefined;
  try{
    @Module({controllers:[TestOnlyController],providers:[{provide:TOKEN,useValue:db}]})
    class TestOnlyModule implements NestModule {
      configure(consumer:MiddlewareConsumer):void{
        consumer.apply(RequestIdMiddleware).forRoutes('*');
      }
    }
    app=await NestFactory.create(TestOnlyModule,{logger:false});
    app.useGlobalFilters(new ApiExceptionFilter());
    const listener=await app.listen(0,'127.0.0.1');
    const port=listener.address();
    if(!port||typeof port==='string')throw new Error('Missing test-only HTTP port');
    const endpoint=`http://127.0.0.1:${port.port}/v1/_auth-admission-test/attempt`;
    const account='synthetic-admission-'+randomUUID()+'@example.com';
    async function hit(body:unknown,spoofedIp='203.0.113.99'){
      return fetch(endpoint,{
        method:'POST',
        headers:{'content-type':'application/json',
          'x-forwarded-for':spoofedIp,'x-real-ip':spoofedIp,
          forwarded:'for=192.0.2.200','x-user-id':'forged-user',
          'x-admin-role':'superadmin','x-request-id':'attacker-supplied-id'},
        body:JSON.stringify(body),
      });
    }
    const login={action:'login',email:account};
    for(let i=0;i<5;i++){
      const ok=await hit(login,'198.51.100.'+(i+1));
      check(ok.status===200,'Spoofed forwarding header incorrectly affected allowed account quota');
      check((await ok.json() as {admitted?:boolean}).admitted===true,
        'Admission response was not successful');
    }
    const throttled=await hit(login,'192.0.2.1');
    check(throttled.status===429,'Parallel account/IP quota did not surface HTTP 429');
    check(throttled.headers.get('retry-after')==='900','Retry-After missing on throttling');
    const limitedError=apiErrorSchema.parse(await throttled.json());
    check(limitedError.error.code==='RATE_LIMITED'&&
      limitedError.error.requestId===throttled.headers.get('x-request-id')&&
      limitedError.error.requestId!=='attacker-supplied-id',
      'Rate error or request-id response contract incorrect');
    check(!JSON.stringify(limitedError).includes(account),
      'Limited response leaked account identifier');

    // 5 accepted from first account + 15 different accounts = per-IP cap 20.
    for(let i=0;i<15;i++){
      const response=await hit({
        action:'login',email:'synthetic-peer-'+randomUUID()+'@example.com',
      },'203.0.113.'+(i+1));
      check(response.status===200,'Spoofed X-Forwarded-For changed the actual TCP peer quota');
    }
    check((await hit({action:'login',
      email:'synthetic-peer-'+randomUUID()+'@example.com'},'192.0.2.4')).status===429,
      'Changing e-mail or proxy headers bypassed per-real-peer IP limit');

    // Separate action buckets, no input-controlled trustedClientIp.
    const reset={action:'password_reset',email:account};
    check((await hit(reset)).status===200,'Independent reset action wrongly shared login quota');
    const bad=await hit({...reset,trustedClientIp:'203.0.113.2'});
    check(bad.status===400,'Client supplied trusted IP was accepted');
    const badError=apiErrorSchema.parse(await bad.json());
    check(badError.error.requestId===bad.headers.get('x-request-id'),
      '400 request ID not returned');

    // Only a test module installs the route. Production AppModule remains closed.
    productionApp=await createFolioApp();
    const publicServer=await productionApp.listen(0,'127.0.0.1');
    const publicAddress=publicServer.address();
    if(!publicAddress||typeof publicAddress==='string')throw new Error('No production app smoke port');
    const exposed=await fetch(`http://127.0.0.1:${publicAddress.port}/v1/_auth-admission-test/attempt`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(login),
    });
    check(exposed.status===404,'Test-only auth admission route was mounted in AppModule');
    const spec=await fetch(`http://127.0.0.1:${publicAddress.port}/openapi-json`);
    check(spec.status===200,'Production OpenAPI could not be read');
    const openapi=await spec.json() as {paths:Record<string,unknown>};
    check(!Object.keys(openapi.paths).some(path=>path.includes('_auth-admission-test')),
      'Test-only auth route appeared in production OpenAPI');
    console.log('AUTH ADMISSION HTTP PASS: real socket peer ignores spoofed proxy headers, 5 account and 20 IP quotas, 429 Retry-After/request-id, strict 400, no production route. Synthetic Folio DB only.');
  }finally{
    if(productionApp)await productionApp.close();
    if(app)await app.close();
    await pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
