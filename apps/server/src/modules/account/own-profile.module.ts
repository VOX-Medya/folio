import {
  BadRequestException,Body,ConflictException,Controller,Get,Header,Inject,Injectable,
  Module,OnModuleDestroy,Patch,Post,Query,Req,ServiceUnavailableException,
  UnauthorizedException,UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth,ApiBody,ApiOkResponse,ApiOperation,ApiSecurity,ApiTags} from '@nestjs/swagger';
import {authenticateUserSession,createFolioDb,getOwnProfile,patchOwnProfile,
  requestOwnAccountDeletion,OwnProfileConflict} from '@folio/db';
import {ownProfileSchema,ownProfileUpdateSchema,ownDeletionRequestSchema} from '@folio/contracts';
import {VERIFIED_SESSION_LOOKUP,VerifiedSelfSessionGuard} from '../../common/session-auth.js';
import type {BearerSessionLookup} from '../../common/session-auth.js';
type OwnerRequest={
  socket?:{encrypted?:boolean};
  auth?:{userId:string;sessionId:string};
  requestId?:string;
};
const output={
  type:'object',additionalProperties:false,
  required:['userId','displayName','locale','visibility','deletionRequestedAt','version'],
  properties:{
    userId:{type:'string',format:'uuid'},displayName:{type:'string',maxLength:80},
    locale:{type:'string',enum:['tr','en']},visibility:{type:'string',enum:['private','friends']},
    deletionRequestedAt:{type:'string',format:'date-time',nullable:true},
    version:{type:'integer',minimum:0},
  },
};
@Injectable()
class OwnProfileDb implements OnModuleDestroy{
  private readonly connection=process.env.DATABASE_URL?createFolioDb(process.env.DATABASE_URL):null;
  verify(token:string){
    if(!this.connection)throw new ServiceUnavailableException('Profile database unavailable');
    return authenticateUserSession(this.connection.db,token);
  }
  private db(){
    if(!this.connection)throw new ServiceUnavailableException('Profile database unavailable');
    return this.connection.db;
  }
  read(user:string,session:string){return getOwnProfile(this.db(),user,session);}
  patch(user:string,session:string,raw:unknown,trace?:string){
    return patchOwnProfile(this.db(),user,session,raw,trace);
  }
  deletion(user:string,session:string,trace?:string){
    return requestOwnAccountDeletion(this.db(),user,session,trace);
  }
  async onModuleDestroy(){await this.connection?.pool.end();}
}
@ApiTags('profile')
@ApiBearerAuth('folioSession')
@ApiSecurity('folioWebSession')
@Controller('v1/me/profile')
@UseGuards(VerifiedSelfSessionGuard)
export class OwnProfileController{
  constructor(@Inject(OwnProfileDb) private readonly service:OwnProfileDb){}
  private owner(request:OwnerRequest,query:Record<string,unknown>){
    if(request.socket?.encrypted!==true){
      throw new ServiceUnavailableException('HTTPS profile access required');
    }
    if(Object.keys(query??{}).length)throw new BadRequestException('Unexpected profile query');
    if(!request.auth?.userId||!request.auth.sessionId){
      throw new UnauthorizedException('Verified session required');
    }
    return request.auth;
  }
  private mapError(error:unknown):never{
    if(error instanceof OwnProfileConflict)throw new ConflictException('Profile version conflict');
    if(error instanceof Error&&error.message==='Verified session required'){
      throw new UnauthorizedException('Verified session required');
    }
    throw new ServiceUnavailableException('Profile unavailable');
  }
  @Get()
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Read only the current verified account private profile'})
  @ApiOkResponse({schema:output})
  async read(@Req() req:OwnerRequest,@Query() query:Record<string,unknown>){
    const owner=this.owner(req,query);
    try{return ownProfileSchema.parse(await this.service.read(owner.userId,owner.sessionId));}
    catch(e){return this.mapError(e);}
  }
  @Patch()
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Save verified account name, TR/EN and privacy with CAS version'})
  @ApiBody({schema:{type:'object',additionalProperties:false,
    required:['expectedVersion','displayName','locale','visibility'],
    properties:{
      expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
      displayName:{type:'string',maxLength:80},
      locale:{type:'string',enum:['tr','en']},
      visibility:{type:'string',enum:['private','friends']},
    },
  }})
  @ApiOkResponse({schema:output})
  async patch(@Req() req:OwnerRequest,@Query() query:Record<string,unknown>,@Body() raw:unknown){
    const owner=this.owner(req,query),data=ownProfileUpdateSchema.safeParse(raw);
    if(!data.success)throw new BadRequestException('Invalid profile update');
    try{return ownProfileSchema.parse(await this.service.patch(
      owner.userId,owner.sessionId,data.data,req.requestId));}
    catch(e){return this.mapError(e);}
  }
  @Post('deletion-request')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Request account deletion; does not immediately erase account'})
  @ApiBody({schema:{type:'object',additionalProperties:false,required:['confirm'],
    properties:{confirm:{type:'boolean',enum:[true]}}}})
  @ApiOkResponse({schema:{type:'object',additionalProperties:false,required:['requested'],
    properties:{requested:{type:'boolean',enum:[true]}}}})
  async requestDeletion(@Req() req:OwnerRequest,@Query() query:Record<string,unknown>,
    @Body() raw:unknown){
    const owner=this.owner(req,query);
    if(!ownDeletionRequestSchema.safeParse(raw).success){
      throw new BadRequestException('Explicit deletion request confirmation required');
    }
    try{return await this.service.deletion(owner.userId,owner.sessionId,req.requestId);}
    catch(e){return this.mapError(e);}
  }
}
@Module({controllers:[OwnProfileController],providers:[OwnProfileDb,VerifiedSelfSessionGuard,
  {provide:VERIFIED_SESSION_LOOKUP,useFactory:(service:OwnProfileDb):BearerSessionLookup=>
    (token:string)=>service.verify(token),inject:[OwnProfileDb]},
]})
export class OwnProfileModule{}
