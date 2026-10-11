import {
  BadRequestException,Body,Controller,Delete,Get,Header,HttpCode,Inject,Injectable,
  Module,NotFoundException,OnModuleDestroy,Param,Put,Query,Req,
  ServiceUnavailableException,UnauthorizedException,UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth,ApiBody,ApiNoContentResponse,ApiOkResponse,ApiOperation,
  ApiParam,ApiSecurity,ApiTags} from '@nestjs/swagger';
import {authenticateUserSession,createFolioDb,deleteOwnedShelf,listOwnedShelf,saveOwnedShelf} from '@folio/db';
import {shelfListSchema,shelfUpdateSchema} from '@folio/contracts';
import {VERIFIED_SESSION_LOOKUP,VerifiedSelfSessionGuard} from '../../common/session-auth.js';
import type {BearerSessionLookup} from '../../common/session-auth.js';
import type {ShelfList} from '@folio/contracts';

interface OwnerRequest{auth?:{userId:string;sessionId:string};requestId?:string;}
const shelfOutput={
  type:'object',additionalProperties:false,required:['items'],
  properties:{items:{type:'array',maxItems:50,items:{
    type:'object',additionalProperties:false,
    required:['id','title','authors','editionId','revisionId','audioAvailable','status'],
    properties:{
      id:{type:'string',format:'uuid'},title:{type:'string'},
      authors:{type:'array',items:{type:'string'}},
      editionId:{type:'string',format:'uuid'},revisionId:{type:'string',format:'uuid'},
      audioAvailable:{type:'boolean'},status:{type:'string',enum:['to-read','reading']},
    },
  }}},
};

@Injectable()
class ShelfDb implements OnModuleDestroy{
  private readonly connection=process.env.DATABASE_URL?createFolioDb(process.env.DATABASE_URL):null;
  verify(bearer:string){
    if(!this.connection)throw new ServiceUnavailableException('Shelf database unavailable');
    return authenticateUserSession(this.connection.db,bearer);
  }
  private db(){
    if(!this.connection)throw new ServiceUnavailableException('Shelf database unavailable');
    return this.connection.db;
  }
  async list(userId:string,sessionId:string,territory:string):Promise<ShelfList>{
    return listOwnedShelf(this.db(),userId,sessionId,territory);
  }
  async save(userId:string,sessionId:string,workId:string,raw:unknown,territory:string,requestId?:string){
    return saveOwnedShelf(this.db(),userId,sessionId,workId,raw,territory,requestId);
  }
  async remove(userId:string,sessionId:string,workId:string,requestId?:string){
    return deleteOwnedShelf(this.db(),userId,sessionId,workId,requestId);
  }
  async onModuleDestroy(){await this.connection?.pool.end();}
}

@ApiTags('shelf')
@ApiBearerAuth('folioSession')
@ApiSecurity('folioWebSession')
@Controller('v1/me/shelf')
@UseGuards(VerifiedSelfSessionGuard)
export class ShelfController{
  constructor(@Inject(ShelfDb) private readonly shelf:ShelfDb){}
  private owner(request:OwnerRequest){
    if(!request.auth?.userId||!request.auth.sessionId)throw new UnauthorizedException('Verified session required');
    return request.auth;
  }
  private territory(){
    const territory=process.env.FOLIO_PUBLIC_CATALOG_TERRITORY;
    if(!territory||!/^[A-Z]{2}$/.test(territory))throw new NotFoundException('Catalog not enabled');
    return territory;
  }
  private noQuery(query:Record<string,unknown>){
    if(Object.keys(query).length)throw new BadRequestException('Unexpected shelf query');
  }
  @Get()
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'List published books saved by the verified current account only'})
  @ApiOkResponse({schema:shelfOutput})
  async list(@Req() req:OwnerRequest,@Query() query:Record<string,unknown>){
    this.noQuery(query);
    const who=this.owner(req);
    try{return shelfListSchema.parse(await this.shelf.list(who.userId,who.sessionId,this.territory()));}
    catch(e){
      if(e instanceof NotFoundException)throw e;
      if(e instanceof Error&&e.message==='Verified session required')throw new UnauthorizedException('Verified session required');
      throw new ServiceUnavailableException('Shelf unavailable');
    }
  }

  @Put(':workId')
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Save one published work on current account reading/to-read shelf'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiBody({schema:{type:'object',additionalProperties:false,required:['status'],
    properties:{status:{type:'string',enum:['to-read','reading']}}}})
  @ApiOkResponse({schema:{type:'object',required:['saved'],properties:{saved:{type:'boolean'}}}})
  async save(@Req() req:OwnerRequest,@Param('workId') workId:string,
    @Query() query:Record<string,unknown>,@Body() raw:unknown){
    this.noQuery(query);
    const parsed=shelfListSchema.shape.items.element.shape.id.safeParse(workId);
    const body=shelfUpdateSchema.safeParse(raw);
    if(!parsed.success||!body.success)throw new BadRequestException('Invalid shelf update');
    const who=this.owner(req);
    try{return await this.shelf.save(who.userId,who.sessionId,workId,body.data,this.territory(),req.requestId);}
    catch(e){
      if(e instanceof NotFoundException)throw e;
      if(e instanceof Error&&e.message==='Published book not found')throw new NotFoundException('Published book not found');
      if(e instanceof Error&&e.message==='Verified session required')throw new UnauthorizedException('Verified session required');
      throw new ServiceUnavailableException('Shelf unavailable');
    }
  }

  @Delete(':workId')
  @HttpCode(204)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Remove a work from only the verified account bookshelf'})
  @ApiParam({name:'workId',type:String,format:'uuid'})
  @ApiNoContentResponse()
  async remove(@Req() req:OwnerRequest,@Param('workId') workId:string,@Query() query:Record<string,unknown>){
    this.noQuery(query);
    if(!shelfListSchema.shape.items.element.shape.id.safeParse(workId).success){
      throw new BadRequestException('Invalid work ID');
    }
    const who=this.owner(req);
    try{await this.shelf.remove(who.userId,who.sessionId,workId,req.requestId);}
    catch(e){
      if(e instanceof Error&&e.message==='Verified session required')throw new UnauthorizedException('Verified session required');
      throw new ServiceUnavailableException('Shelf unavailable');
    }
  }
}

@Module({controllers:[ShelfController],providers:[
  ShelfDb,VerifiedSelfSessionGuard,
  {provide:VERIFIED_SESSION_LOOKUP,useFactory:(store:ShelfDb):BearerSessionLookup=>
    (bearer:string)=>store.verify(bearer),inject:[ShelfDb]},
]})
export class ShelfModule {}
