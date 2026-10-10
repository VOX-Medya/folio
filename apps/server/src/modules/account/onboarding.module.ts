import {
  BadRequestException,Body,Controller,Get,Header,Inject,Injectable,
  MiddlewareConsumer,Module,NestModule,OnModuleDestroy,Patch,Query,
  Req,ServiceUnavailableException,UnauthorizedException,ConflictException,UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth,ApiBody,ApiOkResponse,ApiOperation,ApiTags} from '@nestjs/swagger';
import {
  authenticateUserSession,createFolioDb,getVerifiedUserOnboarding,
  updateVerifiedUserOnboarding,
} from '@folio/db';
import {onboardingUpdateRequestSchema} from '@folio/contracts';
import {VERIFIED_SESSION_LOOKUP,VerifiedSessionGuard} from '../../common/session-auth.js';
import type {BearerSessionLookup} from '../../common/session-auth.js';

interface AuthenticatedRequest {
  auth?:{userId:string;sessionId:string};
  requestId?:string;
}
const stageEnum=['welcome','language','interests','complete'];
const localeEnum=['tr','en'];
const onboardingOutputApiSchema={
  type:'object',
  required:['userId','stage','locale','interests','version'],
  properties:{
    userId:{type:'string',format:'uuid'},
    stage:{type:'string',enum:stageEnum},
    locale:{type:'string',enum:localeEnum},
    interests:{type:'array',items:{type:'string'}},
    version:{type:'integer',minimum:0},
  },
};
const onboardingInputApiSchema={
  type:'object',
  required:['expectedVersion','stage','locale','interests'],
  properties:{
    expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
    stage:{type:'string',enum:stageEnum},
    locale:{type:'string',enum:localeEnum},
    interests:{type:'array',items:{type:'string'},maxItems:20,uniqueItems:true},
  },
};

/**
 * A single Folio DB handle powers both the trusted bearer resolver and
 * ownership-constrained onboarding commands. Never accept user IDs in inputs.
 */
@Injectable()
export class AccountOnboardingDb implements OnModuleDestroy {
  private readonly connection=process.env.DATABASE_URL
    ?createFolioDb(process.env.DATABASE_URL):undefined;

  async verifySession(bearer:string){
    if(!this.connection)throw new ServiceUnavailableException('Database not configured');
    // VerifiedSessionGuard turns any verifier outage into 503, never access.
    return authenticateUserSession(this.connection.db,bearer);
  }
  async read(userId:string){
    if(!this.connection)throw new ServiceUnavailableException('Database not configured');
    try{return await getVerifiedUserOnboarding(this.connection.db,userId);}
    catch(error){
      if(error instanceof Error&&error.message==='Verified user required for onboarding'){
        throw new UnauthorizedException('Verified user required');
      }
      throw new ServiceUnavailableException('Onboarding unavailable');
    }
  }
  async update(userId:string,input:unknown,requestId:string|undefined){
    const parsed=onboardingUpdateRequestSchema.safeParse(input);
    if(!parsed.success)throw new BadRequestException('Invalid onboarding update');
    if(!this.connection)throw new ServiceUnavailableException('Database not configured');
    try{
      return await updateVerifiedUserOnboarding(this.connection.db,userId,parsed.data,requestId);
    }catch(error){
      if(error instanceof Error){
        if(error.message.startsWith('Onboarding version conflict')){
          throw new ConflictException('Onboarding version conflict: reload current state');
        }
        if(error.message==='Onboarding stage cannot skip or regress'){
          throw new BadRequestException('Onboarding stage cannot skip or regress');
        }
        if(error.message==='Verified user required for onboarding'){
          throw new UnauthorizedException('Verified user required');
        }
      }
      throw new ServiceUnavailableException('Onboarding unavailable');
    }
  }
  async onModuleDestroy():Promise<void>{await this.connection?.pool.end();}
}

@ApiTags('account')
@ApiBearerAuth('folioSession')
@Controller('v1/me')
@UseGuards(VerifiedSessionGuard)
export class OnboardingController {
  constructor(@Inject(AccountOnboardingDb) private readonly store:AccountOnboardingDb){}
  private userId(request:AuthenticatedRequest):string{
    if(!request.auth?.userId)throw new UnauthorizedException('Verified session required');
    return request.auth.userId;
  }
  private rejectQuery(query:Record<string,unknown>):void{
    if(Object.keys(query).length)throw new BadRequestException('Unexpected query parameters');
  }
  @Get('onboarding')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Read only the verified bearer owner onboarding snapshot'})
  @ApiOkResponse({schema:onboardingOutputApiSchema})
  async read(@Req() request:AuthenticatedRequest,@Query() query:Record<string,unknown>){
    this.rejectQuery(query);
    return this.store.read(this.userId(request));
  }

  @Patch('onboarding')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Update the verified bearer owner onboarding with optimistic version'})
  @ApiBody({schema:onboardingInputApiSchema})
  @ApiOkResponse({schema:onboardingOutputApiSchema})
  async update(@Req() request:AuthenticatedRequest,@Query() query:Record<string,unknown>,
    @Body() body:unknown){
    this.rejectQuery(query);
    return this.store.update(this.userId(request),body,request.requestId);
  }
}

@Module({
  controllers:[OnboardingController],
  providers:[
    AccountOnboardingDb,VerifiedSessionGuard,
    {provide:VERIFIED_SESSION_LOOKUP,
      useFactory:(store:AccountOnboardingDb):BearerSessionLookup=>
        (bearer:string)=>store.verifySession(bearer),
      inject:[AccountOnboardingDb],
    },
  ],
})
export class AccountOnboardingModule {}
