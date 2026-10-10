import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {
  Controller,Get,Module,NestModule,MiddlewareConsumer,UseGuards,
} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {createFolioDb,registerPendingAccount,verifyAccountEmail,
  signInVerifiedAccount,authenticateUserSession,revokeUserSession} from '@folio/db';
import {apiErrorSchema} from '@folio/contracts';
import {ApiExceptionFilter,RequestIdMiddleware,UserOwnershipGuard} from '../common/http.js';
import {AdminPermissionGuard,RequireAdminPermission} from '../common/admin-rbac.js';
import {VerifiedSessionGuard,VERIFIED_SESSION_LOOKUP} from '../common/session-auth.js';

@Controller('v1/_auth_test/private')
class AuthTestController {
  @Get(':userId')
  @UseGuards(VerifiedSessionGuard,UserOwnershipGuard)
  privateDetails():{visible:true}{return{visible:true};}
  @Get('admin/review')
  @UseGuards(VerifiedSessionGuard,AdminPermissionGuard)
  @RequireAdminPermission('rights:review')
  adminReview():{allowed:true}{return{allowed:true};}
}
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Isolated Folio auth test URL required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Authenticated HTTP test requires only local Folio folio_test DB');
  }
  const {db,pool}=createFolioDb(url);
  const password='Secure-HTTP-Folio-2026!';
  async function newAccount(){
    const email='synthetic-'+randomUUID()+'@example.com';
    const account=await registerPendingAccount(db,email,password);
    await verifyAccountEmail(db,account.verificationToken);
    return {...account,email};
  }
  let app:Awaited<ReturnType<typeof NestFactory.create>>|undefined;
  try{
    const first=await newAccount(),second=await newAccount();
    const session=await signInVerifiedAccount(db,first.email,password,'web');
    const other=await signInVerifiedAccount(db,second.email,password,'android');
    @Module({controllers:[AuthTestController],providers:[
      VerifiedSessionGuard,UserOwnershipGuard,AdminPermissionGuard,
      {provide:VERIFIED_SESSION_LOOKUP,useValue:(bearer:string)=>authenticateUserSession(db,bearer)},
    ]})
    class TestOnlySessionModule implements NestModule{
      configure(consumer:MiddlewareConsumer){consumer.apply(RequestIdMiddleware).forRoutes('*');}
    }
    app=await NestFactory.create(TestOnlySessionModule,{logger:false});
    app.useGlobalFilters(new ApiExceptionFilter());
    const server=await app.listen(0,'127.0.0.1');
    const address=server.address();
    if(!address||typeof address==='string')throw new Error('No test listener');
    const root='http://127.0.0.1:'+address.port+'/v1/_auth_test/private';
    const owner=root+'/'+first.userId;
    const header={authorization:'Bearer '+session.sessionToken};
    const unauth=await fetch(owner,{headers:{
      'x-user-id':first.userId,'x-admin-role':'superadmin','x-request-id':'client-spoof',
    }});
    check(unauth.status===401,'Spoofed headers authenticated a user');
    const error=apiErrorSchema.parse(await unauth.json());
    check(error.error.requestId===unauth.headers.get('x-request-id')&&
      error.error.requestId!=='client-spoof','Request ID was client supplied');
    const foreign=await fetch(owner,{headers:{authorization:'Bearer '+other.sessionToken,
      'x-user-id':first.userId}});
    check(foreign.status===403,'Cross-owner bearer obtained private data');
    const right=await fetch(owner,{headers:header});
    check(right.status===200&&(await right.json() as {visible:boolean}).visible,
      'Verified bearer could not access its own test-only route');
    const forgedAdmin=await fetch(root+'/admin/review',{headers:{
      ...header,'x-admin-role':'superadmin',
    }});
    check(forgedAdmin.status===403,'Bearer header spoofed admin role');
    const malformed=await fetch(owner,{headers:{authorization:'Bearer forged-raw-token'}});
    check(malformed.status===401,'Malformed bearer accepted');

    check((await revokeUserSession(db,session.sessionToken)).revoked,'Token revocation failed');
    check((await fetch(owner,{headers:header})).status===401,
      'Revoked bearer was accepted over HTTP');
    console.log('AUTH HTTP PASS: verified account to hashed bearer to owner guard, 401 spoof, 403 cross-user/admin, request ID, revoke invalidates. Test-only routes, no live module.');
  }finally{
    if(app)await app.close();
    await pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
