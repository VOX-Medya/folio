import {describe,expect,it} from 'vitest';
import {Controller,Get,MiddlewareConsumer,Module,NestMiddleware,NestModule,UseGuards} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {apiErrorSchema} from '@folio/contracts';
import {ApiExceptionFilter,RequestIdMiddleware,UserOwnershipGuard} from './main.js';

let trustedPrincipal: string|undefined;

/** Only the TEST middleware injects authenticated context. Request headers never do. */
class TestTrustedPrincipalMiddleware implements NestMiddleware {
  use(request:{auth?:{userId:string}},_response:unknown,next:()=>void):void {
    if (trustedPrincipal) request.auth={userId:trustedPrincipal};
    next();
  }
}

@Controller('v1/private/:userId')
class TestOnlyOwnerController {
  @Get('test')
  @UseGuards(UserOwnershipGuard)
  readOwnRecord(): {visible:boolean} {return {visible:true};}
}
@Module({controllers:[TestOnlyOwnerController],providers:[UserOwnershipGuard]})
class TestOnlyAuthModule implements NestModule {
  configure(consumer:MiddlewareConsumer):void {
    consumer.apply(RequestIdMiddleware,TestTrustedPrincipalMiddleware).forRoutes('*');
  }
}

describe('real HTTP user ownership boundary (test-only routes)',()=>{
  it('rejects spoofed IDs, mismatched principals and accepts trusted same owner',async()=>{
    trustedPrincipal=undefined;
    const app=await NestFactory.create(TestOnlyAuthModule,{logger:false});
    app.useGlobalFilters(new ApiExceptionFilter());
    try {
      const server=await app.listen(0,'127.0.0.1');
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('Test listener address unavailable');
      const url=`http://127.0.0.1:${address.port}/v1/private/alice/test`;
      const denied=await fetch(url,{headers:{'x-user-id':'alice','x-request-id':'spoofed'}});
      expect(denied.status).toBe(401);
      const deniedBody=apiErrorSchema.parse(await denied.json());
      expect(deniedBody.error.code).toBe('UNAUTHORIZED');
      expect(deniedBody.error.requestId).toBe(denied.headers.get('x-request-id'));
      expect(deniedBody.error.requestId).not.toBe('spoofed');
      trustedPrincipal='bob';
      const forbidden=await fetch(url,{headers:{'x-user-id':'alice'}});
      expect(forbidden.status).toBe(403);
      const forbiddenBody=apiErrorSchema.parse(await forbidden.json());
      expect(forbiddenBody.error.code).toBe('FORBIDDEN');
      expect(forbiddenBody.error.requestId).toBe(forbidden.headers.get('x-request-id'));
      trustedPrincipal='alice';
      const allowed=await fetch(url);
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({visible:true});
    }finally {
      trustedPrincipal=undefined;
      await app.close();
    }
  });
});
