import {
  BadRequestException,Body,ConflictException,Controller,Get,Header,HttpCode,
  Inject,Injectable,Module,NotFoundException,OnModuleDestroy,Param,Post,
  Query,Req,ServiceUnavailableException,UnauthorizedException,UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth,ApiBody,ApiOkResponse,ApiOperation,ApiParam,ApiSecurity,ApiTags}
  from '@nestjs/swagger';
import {
  authenticateUserSession,createFolioDb,rotateVerifiedFriendInvite,listVerifiedFriendLinks,
  requestVerifiedFriendLink,acceptVerifiedFriendLink,blockVerifiedFriendLink,FriendshipDenied,
} from '@folio/db';
import {friendRequestInputSchema,friendListSchema,friendInviteCodeSchema,
  friendOperationResultSchema} from '@folio/contracts';
import {VERIFIED_SESSION_LOOKUP,VerifiedSelfSessionGuard} from '../../common/session-auth.js';
import type {BearerSessionLookup} from '../../common/session-auth.js';

type RequestOwner={socket?:{encrypted?:boolean};auth?:{userId:string;sessionId:string};requestId?:string};
const peerItems={
  type:'object',additionalProperties:false,
  required:['peerId','state'],
  properties:{
    peerId:{type:'string',format:'uuid'},
    state:{type:'string',enum:['incoming','outgoing','accepted','blocked']},
  },
};
const listOutput={
  type:'object',additionalProperties:false,required:['items'],
  properties:{items:{type:'array',maxItems:100,items:peerItems}},
};
const inviteOutput={
  type:'object',additionalProperties:false,required:['code'],
  properties:{code:{type:'string',minLength:32,maxLength:32}},
};
const actionOutput={
  type:'object',additionalProperties:false,required:['state'],
  properties:{state:{type:'string',enum:['pending','accepted','blocked']}},
};

@Injectable()
class FriendsDb implements OnModuleDestroy{
  private readonly connection=process.env.DATABASE_URL?createFolioDb(process.env.DATABASE_URL):null;
  verify(token:string){
    if(!this.connection)throw new ServiceUnavailableException('Friends database unavailable');
    return authenticateUserSession(this.connection.db,token);
  }
  private db(){
    if(!this.connection)throw new ServiceUnavailableException('Friends database unavailable');
    return this.connection.db;
  }
  list(user:string,session:string){return listVerifiedFriendLinks(this.db(),user,session);}
  rotate(user:string,session:string,trace?:string){
    return rotateVerifiedFriendInvite(this.db(),user,session,trace);
  }
  request(user:string,session:string,body:unknown,trace?:string){
    return requestVerifiedFriendLink(this.db(),user,session,body,trace);
  }
  accept(user:string,session:string,peer:string,trace?:string){
    return acceptVerifiedFriendLink(this.db(),user,session,peer,trace);
  }
  block(user:string,session:string,peer:string,trace?:string){
    return blockVerifiedFriendLink(this.db(),user,session,peer,trace);
  }
  async onModuleDestroy(){await this.connection?.pool.end();}
}
@ApiTags('friendships')
@ApiBearerAuth('folioSession')
@ApiSecurity('folioWebSession')
@Controller('v1/me/friends')
@UseGuards(VerifiedSelfSessionGuard)
export class FriendsController{
  constructor(@Inject(FriendsDb)private readonly domain:FriendsDb){}
  private who(req:RequestOwner,query:Record<string,unknown>){
    if(req.socket?.encrypted!==true)throw new ServiceUnavailableException('HTTPS friends required');
    if(Object.keys(query??{}).length)throw new BadRequestException('Unexpected friends query');
    if(!req.auth?.userId||!req.auth.sessionId)throw new UnauthorizedException('Verified session required');
    return req.auth;
  }
  private failure(error:unknown):never{
    if(error instanceof FriendshipDenied){
      if(error.kind==='conflict')throw new ConflictException('Friendship already exists');
      throw new NotFoundException('Friendship not available');
    }
    if(error instanceof Error&&error.message==='Verified session required'){
      throw new UnauthorizedException('Verified session required');
    }
    throw new ServiceUnavailableException('Friendship unavailable');
  }
  @Get()
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'List only the current verified account invite relationships'})
  @ApiOkResponse({schema:listOutput})
  async list(@Req()req:RequestOwner,@Query()query:Record<string,unknown>){
    const actor=this.who(req,query);
    try{return friendListSchema.parse(await this.domain.list(actor.userId,actor.sessionId));}
    catch(e){return this.failure(e);}
  }
  @Post('invite')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Rotate an owner-only random invite code; store only SHA-256'})
  @ApiOkResponse({schema:inviteOutput})
  async rotate(@Req()req:RequestOwner,@Query()query:Record<string,unknown>){
    const actor=this.who(req,query);
    try{return friendInviteCodeSchema.parse(await this.domain.rotate(actor.userId,actor.sessionId,req.requestId));}
    catch(e){return this.failure(e);}
  }
  @Post('requests')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Request friendship using an exact invite code, never people search'})
  @ApiBody({schema:{type:'object',additionalProperties:false,required:['code'],
    properties:{code:{type:'string',minLength:32,maxLength:32}}}})
  @ApiOkResponse({schema:actionOutput})
  async request(@Req()req:RequestOwner,@Query()query:Record<string,unknown>,
    @Body()body:unknown){
    const actor=this.who(req,query);
    const valid=friendRequestInputSchema.safeParse(body);
    if(!valid.success)throw new BadRequestException('Invalid invite code');
    try{return friendOperationResultSchema.parse(await this.domain.request(
      actor.userId,actor.sessionId,valid.data,req.requestId));}
    catch(e){return this.failure(e);}
  }
  @Post(':peerId/accept')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Accept only an incoming pending request for current owner'})
  @ApiParam({name:'peerId',type:String,format:'uuid'})
  @ApiOkResponse({schema:actionOutput})
  async accept(@Req()req:RequestOwner,@Query()query:Record<string,unknown>,
    @Param('peerId')peerId:string){
    const actor=this.who(req,query);
    if(!friendListSchema.shape.items.element.shape.peerId.safeParse(peerId).success){
      throw new BadRequestException('Invalid peer id');
    }
    try{return friendOperationResultSchema.parse(await this.domain.accept(
      actor.userId,actor.sessionId,peerId,req.requestId));}
    catch(e){return this.failure(e);}
  }
  @Post(':peerId/block')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Block an existing relation; blocked peer sees no relationship'})
  @ApiParam({name:'peerId',type:String,format:'uuid'})
  @ApiOkResponse({schema:actionOutput})
  async block(@Req()req:RequestOwner,@Query()query:Record<string,unknown>,
    @Param('peerId')peerId:string){
    const actor=this.who(req,query);
    if(!friendListSchema.shape.items.element.shape.peerId.safeParse(peerId).success){
      throw new BadRequestException('Invalid peer id');
    }
    try{return friendOperationResultSchema.parse(await this.domain.block(
      actor.userId,actor.sessionId,peerId,req.requestId));}
    catch(e){return this.failure(e);}
  }
}
@Module({controllers:[FriendsController],providers:[
  FriendsDb,VerifiedSelfSessionGuard,
  {provide:VERIFIED_SESSION_LOOKUP,useFactory:(service:FriendsDb):BearerSessionLookup=>
    (token:string)=>service.verify(token),inject:[FriendsDb]},
]})
export class FriendsModule{}
