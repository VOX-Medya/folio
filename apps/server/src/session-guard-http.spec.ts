import 'reflect-metadata';
import {describe,expect,it} from 'vitest';
import {Controller,Get,Injectable,Module,UseGuards} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {apiErrorSchema} from '@folio/contracts';
import {ApiExceptionFilter,RequestIdMiddleware} from './common/http.js';
import {FolioSessionVerifier,VerifiedBearerSessionGuard} from './common/session-guard.js';
import {MiddlewareConsumer,NestModule} from '@nestjs/common';

const goodToken='A'.repeat(43);
const goodUser='dc0e8057-6a23-4ead-9ed7-6f5b26650b55';
const goodSession='718e64da-04fd-42cb-ae18-1e111fa843ba';

@Injectable()
class TestOnlyVerifier {
  async verify(token:string){
    return token===goodToken?{userId:goodUser,sessionId:goodSession}:null;
  }
}
@Controller('v1/_test-session')
class TestOnlySessionController {
  @Get('whoami')
  @UseGuards(VerifiedBearerSessionGuard)
  whoami():{authenticated:true}{return {authenticated:true};}
}
@Module({controllers:[TestOnlySessionController],
  providers:[VerifiedBearerSessionGuard,
    {provide:FolioSessionVerifier,useClass:TestOnlyVerifier}]})
class TestOnlyModule implements NestModule {
  configure(consumer:MiddlewareConsumer):void{
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

describe('real HTTP verified session guard, test-only route',()=>{
  it('rejects spoofed user/admin headers, malformed/unknown bearer; accepts verified token',async()=>{
    const app=await NestFactory.create(TestOnlyModule,{logger:false});
    app.useGlobalFilters(new ApiExceptionFilter());
    try{
      const listener=await app.listen(0,'127.0.0.1');
      const address=listener.address();
      if(!address||typeof address==='string')throw new Error('Missing synthetic test listener');
      const url=`http://127.0.0.1:${address.port}/v1/_test-session/whoami`;
      const cases=[
        {'x-user-id':goodUser,'x-admin-role':'superadmin'},
        {'authorization':'Bearer x','x-user-id':goodUser},
        {'authorization':'Bearer '+'B'.repeat(43),'x-admin-role':'superadmin'},
        {'authorization':'bearer '+goodToken},
        {'authorization':'Basic '+goodToken},
      ];
      for(const headers of cases){
        const response=await fetch(url,{headers});
        expect(response.status).toBe(401);
        const error=apiErrorSchema.parse(await response.json());
        expect(error.error.code).toBe('UNAUTHORIZED');
        expect(error.error.requestId).toBe(response.headers.get('x-request-id'));
      }
      const allowed=await fetch(url,{headers:{
        authorization:'Bearer '+goodToken,
        'x-user-id':'forged','x-admin-role':'superadmin',
      }});
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({authenticated:true});
    }finally{await app.close();}
  });
});
