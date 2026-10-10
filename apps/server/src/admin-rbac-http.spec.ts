import 'reflect-metadata';
import {describe,expect,it} from 'vitest';
import {Controller,Get,MiddlewareConsumer,Module,NestMiddleware,NestModule,UseGuards} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {apiErrorSchema} from '@folio/contracts';
import {ApiExceptionFilter,RequestIdMiddleware} from './common/http.js';
import {AdminPermissionGuard,RequireAdminPermission} from './common/admin-rbac.js';

let trustedAdmin:{userId:string;adminRoles:string[]}|undefined;

/** The only source of authenticated roles in this suite is test middleware. */
class TestAdminSessionMiddleware implements NestMiddleware {
  use(request:{auth?:{userId:string;adminRoles:readonly string[]}},_response:unknown,next:()=>void):void{
    if(trustedAdmin)request.auth={...trustedAdmin};
    next();
  }
}
@Controller('v1/_test-only-admin')
class PrivateTestController {
  @Get('rights')
  @UseGuards(AdminPermissionGuard)
  @RequireAdminPermission('rights:review')
  review():{accepted:true}{return {accepted:true};}

  @Get('view')
  @UseGuards(AdminPermissionGuard)
  @RequireAdminPermission('admin:view')
  view():{accepted:true}{return {accepted:true};}

  @Get('private-book-body')
  @UseGuards(AdminPermissionGuard)
  @RequireAdminPermission('personal:book:read')
  privateBody():{accepted:true}{return {accepted:true};}

  @Get('undeclared')
  @UseGuards(AdminPermissionGuard)
  undeclared():{accepted:true}{return {accepted:true};}
}
@Module({controllers:[PrivateTestController],providers:[AdminPermissionGuard]})
class TestOnlyAdminModule implements NestModule {
  configure(consumer:MiddlewareConsumer):void {
    consumer.apply(RequestIdMiddleware,TestAdminSessionMiddleware).forRoutes('*');
  }
}

describe('RBAC HTTP boundaries on real ephemeral NestJS sockets (test-only)',()=>{
  it('never trusts spoofed role headers or exposes private user book bodies',async()=>{
    trustedAdmin=undefined;
    const app=await NestFactory.create(TestOnlyAdminModule,{logger:false});
    app.useGlobalFilters(new ApiExceptionFilter());
    try{
      const server=await app.listen(0,'127.0.0.1');
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('No local test HTTP listener');
      const base=`http://127.0.0.1:${address.port}/v1/_test-only-admin`;
      const spoof=await fetch(base+'/rights',{
        headers:{'x-user-id':'admin','x-admin-role':'superadmin','x-request-id':'spoofed'},
      });
      expect(spoof.status).toBe(401);
      const denied=apiErrorSchema.parse(await spoof.json());
      expect(denied.error.code).toBe('UNAUTHORIZED');
      expect(denied.error.requestId).toBe(spoof.headers.get('x-request-id'));
      expect(denied.error.requestId).not.toBe('spoofed');

      trustedAdmin={userId:'test-editor',adminRoles:['editor']};
      const forbidden=await fetch(base+'/rights',{headers:{'x-admin-role':'superadmin'}});
      expect(forbidden.status).toBe(403);

      trustedAdmin={userId:'test-rights',adminRoles:['rights']};
      const allowed=await fetch(base+'/rights');
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({accepted:true});

      trustedAdmin={userId:'test-viewer',adminRoles:['read-only']};
      expect((await fetch(base+'/view')).status).toBe(200);
      expect((await fetch(base+'/rights')).status).toBe(403);

      trustedAdmin={userId:'test-superadmin',adminRoles:['superadmin']};
      expect((await fetch(base+'/rights')).status).toBe(200);
      expect((await fetch(base+'/private-book-body')).status).toBe(403);
      expect((await fetch(base+'/undeclared')).status).toBe(403);
    }finally{
      trustedAdmin=undefined;
      await app.close();
    }
  });
});
