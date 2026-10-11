import {
  BadRequestException,Body,ConflictException,Controller,Get,Header,Inject,Injectable,
  Module,NotFoundException,OnModuleDestroy,Param,Put,Query,Req,
  ServiceUnavailableException,UnauthorizedException,UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth,ApiBody,ApiOkResponse,ApiOperation,ApiParam,ApiSecurity,ApiTags} from '@nestjs/swagger';
import {
  authenticateUserSession,createFolioDb,getOwnedReadingPosition,putOwnedReadingPosition,
  InvalidReadingAnchor,ReadingPositionConflict,ReadingPositionNotFound,
} from '@folio/db';
import {readingPositionResponseSchema,readingPositionUpdateSchema} from '@folio/contracts';
import type {ReadingPositionResponse} from '@folio/contracts';
import {VERIFIED_SESSION_LOOKUP,VerifiedSelfSessionGuard} from '../../common/session-auth.js';
import type {BearerSessionLookup} from '../../common/session-auth.js';

interface OwnerRequest{
  socket?:{encrypted?:boolean};
  auth?:{userId:string;sessionId:string};
}
const progressOutput={
  type:'object',additionalProperties:false,required:['progress'],
  properties:{progress:{
    type:'object',nullable:true,additionalProperties:false,
    required:['revisionId','chapterId','blockId','tokenOffset','audioPositionMs','mode','version'],
    properties:{
      revisionId:{type:'string',format:'uuid'},chapterId:{type:'string',format:'uuid'},
      blockId:{type:'string',format:'uuid'},tokenOffset:{type:'integer',minimum:0,maximum:30000},
      audioPositionMs:{type:'integer',nullable:true,minimum:0,maximum:86400000},
      mode:{type:'string',enum:['normal','rsvp','audio']},
      version:{type:'integer',minimum:1},
    },
  }},
};

@Injectable()
class ReadingPositionDb implements OnModuleDestroy{
  private readonly connection=process.env.DATABASE_URL?createFolioDb(process.env.DATABASE_URL):null;
  verify(bearer:string){
    if(!this.connection)throw new ServiceUnavailableException('Reading position unavailable');
    return authenticateUserSession(this.connection.db,bearer);
  }
  private db(){
    if(!this.connection)throw new ServiceUnavailableException('Reading position unavailable');
    return this.connection.db;
  }
  get(user:string,session:string,revision:string,territory:string){
    return getOwnedReadingPosition(this.db(),user,session,revision,territory);
  }
  put(user:string,session:string,revision:string,input:unknown,territory:string){
    return putOwnedReadingPosition(this.db(),user,session,revision,input,territory);
  }
  async onModuleDestroy(){await this.connection?.pool.end();}
}

@ApiTags('reading-progress')
@ApiBearerAuth('folioSession')
@ApiSecurity('folioWebSession')
@Controller('v1/me/progress')
@UseGuards(VerifiedSelfSessionGuard)
export class ReadingPositionController{
  constructor(@Inject(ReadingPositionDb) private readonly positions:ReadingPositionDb){}
  private authorize(request:OwnerRequest,query:Record<string,unknown>,revisionId:string){
    if(request.socket?.encrypted!==true){
      throw new ServiceUnavailableException('Secure reading progress required');
    }
    if(!request.auth?.userId||!request.auth.sessionId){
      throw new UnauthorizedException('Verified session required');
    }
    if(Object.keys(query??{}).length||!readingPositionResponseSchema.shape.progress
      .unwrap().shape.revisionId.safeParse(revisionId).success){
      throw new BadRequestException('Invalid reading position route');
    }
    const territory=process.env.FOLIO_PUBLIC_CATALOG_TERRITORY;
    if(!territory||!/^[A-Z]{2}$/.test(territory)){
      throw new NotFoundException('Published reader not enabled');
    }
    return {...request.auth,territory};
  }
  private mapError(error:unknown):never{
    if(error instanceof ReadingPositionNotFound)throw new NotFoundException('Published reader not found');
    if(error instanceof InvalidReadingAnchor)throw new BadRequestException('Invalid published reading anchor');
    if(error instanceof ReadingPositionConflict)throw new ConflictException('Reading position version conflict');
    if(error instanceof Error&&error.message==='Verified session required'){
      throw new UnauthorizedException('Verified session required');
    }
    throw new ServiceUnavailableException('Reading progress unavailable');
  }
  @Get(':revisionId')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Read current verified account position for a published revision'})
  @ApiParam({name:'revisionId',type:String,format:'uuid'})
  @ApiOkResponse({schema:progressOutput})
  async read(@Req() req:OwnerRequest,@Param('revisionId') revisionId:string,
    @Query() query:Record<string,unknown>):Promise<ReadingPositionResponse>{
    const who=this.authorize(req,query,revisionId);
    try{
      const progress=await this.positions.get(who.userId,who.sessionId,revisionId,who.territory);
      return readingPositionResponseSchema.parse({progress});
    }catch(error){return this.mapError(error);}
  }
  @Put(':revisionId')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Compare-and-swap current account reading position; stale version is 409'})
  @ApiParam({name:'revisionId',type:String,format:'uuid'})
  @ApiBody({schema:{type:'object',additionalProperties:false,
    required:['expectedVersion','chapterId','blockId','tokenOffset','audioPositionMs','mode'],
    properties:{
      expectedVersion:{type:'integer',minimum:0,maximum:2147483646},
      chapterId:{type:'string',format:'uuid'},blockId:{type:'string',format:'uuid'},
      tokenOffset:{type:'integer',minimum:0,maximum:30000},
      audioPositionMs:{type:'integer',nullable:true,minimum:0,maximum:86400000},
      mode:{type:'string',enum:['normal','rsvp','audio']},
    },
  }})
  @ApiOkResponse({schema:progressOutput})
  async save(@Req() req:OwnerRequest,@Param('revisionId') revisionId:string,
    @Query() query:Record<string,unknown>,@Body() raw:unknown):Promise<ReadingPositionResponse>{
    const who=this.authorize(req,query,revisionId);
    const input=readingPositionUpdateSchema.safeParse(raw);
    if(!input.success)throw new BadRequestException('Invalid reading position');
    try{
      const progress=await this.positions.put(who.userId,who.sessionId,revisionId,input.data,who.territory);
      return readingPositionResponseSchema.parse({progress});
    }catch(error){return this.mapError(error);}
  }
}
@Module({controllers:[ReadingPositionController],providers:[
  ReadingPositionDb,VerifiedSelfSessionGuard,
  {provide:VERIFIED_SESSION_LOOKUP,useFactory:(store:ReadingPositionDb):BearerSessionLookup=>
    (bearer:string)=>store.verify(bearer),inject:[ReadingPositionDb]},
]})
export class ReadingPositionModule {}
