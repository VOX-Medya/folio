import {
  BadRequestException,Body,ConflictException,Controller,ForbiddenException,Get,Header,
  HttpCode,Inject,Injectable,Module,NotFoundException,OnModuleDestroy,Post,Query,Req,
  ServiceUnavailableException,UnauthorizedException,UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth,ApiBody,ApiOkResponse,ApiOperation,ApiSecurity,ApiTags} from '@nestjs/swagger';
import {
  authenticateUserSession,createFolioDb,rotateOwnedInvite,redeemOwnedInvite,
  decideOwnedFriendship,listOwnedFriendships,
  FriendInviteNotFound,FriendshipConflict,FriendshipNotFound,FriendshipForbidden,
} from '@folio/db';
import {
  friendInviteIssueSchema,friendInviteIssuedSchema,friendInviteRedeemSchema,
  friendRequestResultSchema,friendshipActionSchema,friendshipDecisionResultSchema,
  friendshipListSchema,
} from '@folio/contracts';
import {VERIFIED_SESSION_LOOKUP,VerifiedSelfSessionGuard} from '../../common/session-auth.js';
import type {BearerSessionLookup} from '../../common/session-auth.js';

type OwnerRequest={socket?:{encrypted?:boolean};auth?:{userId:string;sessionId:string}};
const issuedOutput={
  type:'object',additionalProperties:false,required:['code','expiresAt'],
  properties:{code:{type:'string',pattern:'^[A-Z2-9]{16}$'},
    expiresAt:{type:'string',format:'date-time'}},
};
const requestOutput={
  type:'object',additionalProperties:false,required:['requestId','state'],
  properties:{requestId:{type:'string',format:'uuid'},state:{type:'string',enum:['pending']}},
};
const decisionOutput={
  type:'object',additionalProperties:false,required:['state'],
  properties:{state:{type:'string',enum:['accepted','rejected','blocked']}},
};
const listOutput={
  type:'object',additionalProperties:false,required:['items'],
  properties:{items:{type:'array',maxItems:100,items:{
    type:'object',additionalProperties:false,
    required:['requestId','direction','state','displayName'],
    properties:{
      requestId:{type:'string',format:'uuid'},
      direction:{type:'string',enum:['incoming','outgoing']},
      state:{type:'string',enum:['pending','accepted','blocked']},
      displayName:{type:'string',nullable:true,maxLength:80},
    },
  }}},
};
@Injectable()
class FriendshipDb implements OnModuleDestroy{
  private readonly connection=process.env.DATABASE_URL?createFolioDb(process.env.DATABASE_URL):null;
  verify(token:string){
    if(!this.connection)throw new ServiceUnavailableException('Friendship unavailable');
    return authenticateUserSession(this.connection.db,token);
  }
  private db(){
    if(!this.connection)throw new ServiceUnavailableException('Friendship unavailable');
    return this.connection.db;
  }
  issue(user:string,session:string){return rotateOwnedInvite(this.db(),user,session);}
  redeem(user:string,session:string,code:string){return redeemOwnedInvite(this.db(),user,session,code);}
  decide(user:string,session:string,body:unknown){return decideOwnedFriendship(this.db(),user,session,body);}
  list(user:string,session:string){return listOwnedFriendships(this.db(),user,session);}
  async onModuleDestroy(){await this.connection?.pool.end();}
}

@ApiTags('friendship')
@ApiBearerAuth('folioSession')
@ApiSecurity('folioWebSession')
@Controller('v1/me/friends')
@UseGuards(VerifiedSelfSessionGuard)
export class FriendshipController{
  constructor(@Inject(FriendshipDb) private readonly friends:FriendshipDb){}
  private owner(req:OwnerRequest,query:Record<string,unknown>){
    if(req.socket?.encrypted!==true){
      throw new ServiceUnavailableException('HTTPS friendship access required');
    }
    if(Object.keys(query??{}).length)throw new BadRequestException('Unexpected friendship query');
    if(!req.auth?.userId||!req.auth.sessionId){
      throw new UnauthorizedException('Verified session required');
    }
    return req.auth;
  }
  private fail(error:unknown):never{
    if(error instanceof FriendInviteNotFound||error instanceof FriendshipNotFound){
      throw new NotFoundException('Invite or friendship unavailable');
    }
    if(error instanceof FriendshipConflict)throw new ConflictException('Friendship unavailable');
    if(error instanceof FriendshipForbidden)throw new ForbiddenException('Friendship action denied');
    if(error instanceof Error&&error.message==='Verified session required'){
      throw new UnauthorizedException('Verified session required');
    }
    throw new ServiceUnavailableException('Friendship unavailable');
  }
  @Get()
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'List current account invitation requests and accepted friends, no directory'})
  @ApiOkResponse({schema:listOutput})
  async list(@Req() req:OwnerRequest,@Query() query:Record<string,unknown>){
    const who=this.owner(req,query);
    try{return friendshipListSchema.parse(await this.friends.list(who.userId,who.sessionId));}
    catch(e){return this.fail(e);}
  }
  @Post('invite')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Rotate a private random invitation code with seven-day expiration'})
  @ApiBody({schema:{type:'object',additionalProperties:false,required:['rotate'],
    properties:{rotate:{type:'boolean',enum:[true]}}}})
  @ApiOkResponse({schema:issuedOutput})
  async issue(@Req() req:OwnerRequest,@Query() query:Record<string,unknown>,@Body() raw:unknown){
    const who=this.owner(req,query);
    if(!friendInviteIssueSchema.safeParse(raw).success)throw new BadRequestException('Invalid invite request');
    try{return friendInviteIssuedSchema.parse(await this.friends.issue(who.userId,who.sessionId));}
    catch(e){return this.fail(e);}
  }
  @Post('request')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Request friendship using a private invitation code, never user search'})
  @ApiBody({schema:{type:'object',additionalProperties:false,required:['code'],
    properties:{code:{type:'string',pattern:'^[A-Z2-9]{16}$'}}}})
  @ApiOkResponse({schema:requestOutput})
  async request(@Req() req:OwnerRequest,@Query() query:Record<string,unknown>,@Body() raw:unknown){
    const who=this.owner(req,query),input=friendInviteRedeemSchema.safeParse(raw);
    if(!input.success)throw new BadRequestException('Invalid invitation code');
    try{return friendRequestResultSchema.parse(await this.friends.redeem(
      who.userId,who.sessionId,input.data.code));}
    catch(e){return this.fail(e);}
  }
  @Post('decision')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Accept/reject incoming request or block an existing pairing'})
  @ApiBody({schema:{type:'object',additionalProperties:false,required:['requestId','action'],
    properties:{
      requestId:{type:'string',format:'uuid'},
      action:{type:'string',enum:['accept','reject','block']},
    }}})
  @ApiOkResponse({schema:decisionOutput})
  async decide(@Req() req:OwnerRequest,@Query() query:Record<string,unknown>,@Body() raw:unknown){
    const who=this.owner(req,query),input=friendshipActionSchema.safeParse(raw);
    if(!input.success)throw new BadRequestException('Invalid friendship decision');
    try{return friendshipDecisionResultSchema.parse(await this.friends.decide(
      who.userId,who.sessionId,input.data));}
    catch(e){return this.fail(e);}
  }
}
@Module({controllers:[FriendshipController],providers:[
  FriendshipDb,VerifiedSelfSessionGuard,
  {provide:VERIFIED_SESSION_LOOKUP,useFactory:(service:FriendshipDb):BearerSessionLookup=>
    (token:string)=>service.verify(token),inject:[FriendshipDb]},
]})
export class FriendshipModule{}
