import {
  BadRequestException,Body,CanActivate,Controller,ExecutionContext,
  Header,HttpCode,Inject,Injectable,Module,NotFoundException,
  OnModuleDestroy,Post,Query,Req,ServiceUnavailableException,
  UnauthorizedException,UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,ApiBody,ApiNoContentResponse,ApiOkResponse,
  ApiOperation,ApiSecurity,ApiTags,
} from '@nestjs/swagger';
import {
  authenticateUserSession,beginAdminTotpEnrollment,
  confirmAdminTotpEnrollment,createFolioDb,requireTotpKeyring,
  verifyAdminTotpForSession,
} from '@folio/db';
import type {TotpKeyring,TotpKeyVersion} from '@folio/db';
import {adminTotpCodeRequestSchema} from '@folio/contracts';
import {
  VERIFIED_SESSION_LOOKUP,VerifiedSelfSessionGuard,
} from '../../common/session-auth.js';
import type {BearerSessionLookup} from '../../common/session-auth.js';
import {verifiedWebCookieBearer} from '../../common/web-cookie-session.js';

interface AdminMfaRequest {
  socket?:{encrypted?:boolean};
  headers?:Record<string,string|string[]|undefined>;
  method?:string;
  requestId?:string;
  auth?:{userId:string;sessionId:string};
}
const denied=()=>new UnauthorizedException('Verified admin MFA session required');

/** Two-key staged rollover: legacy v1 remains active by default.
 * v2 encryption requires an explicitly configured and distinct AES key.
 * Never derive keys or versions from HTTP request contents. */
function configuredTotpKeys():TotpKeyring{
  const name=process.env.FOLIO_ADMIN_TOTP_ACTIVE_KEY_VERSION??'v1';
  if(name!=='v1'&&name!=='v2'){
    throw new Error('Invalid TOTP active key version');
  }
  const activeVersion:TotpKeyVersion=name;
  const v1=process.env.FOLIO_ADMIN_TOTP_KEY_HEX;
  const v2=process.env.FOLIO_ADMIN_TOTP_V2_KEY_HEX;
  return requireTotpKeyring({
    activeVersion,
    ...(v1!==undefined?{v1}:{}),
    ...(v2!==undefined?{v2}:{}),
  });
}


/**
 * The feature is opt-in AND restricted to actual application socket TLS.
 * No reverse proxy header can opt in to MFA. Never enable using 'true'.
 */
@Injectable()
export class AdminMfaOptInGuard implements CanActivate {
  canActivate(context:ExecutionContext):boolean{
    if(process.env.FOLIO_ADMIN_TOTP_HTTP_MODE!=='direct-tls-only'){
      throw new NotFoundException('Admin factor route unavailable');
    }
    const request=context.switchToHttp().getRequest<AdminMfaRequest>();
    if(request.socket?.encrypted!==true){
      throw new ServiceUnavailableException('Verified application HTTPS required');
    }
    try{configuredTotpKeys();}
    catch{throw new ServiceUnavailableException('Admin factor configuration unavailable');}
    return true;
  }
}

@Injectable()
export class AdminTotpDb implements OnModuleDestroy {
  private readonly connection=process.env.DATABASE_URL
    ?createFolioDb(process.env.DATABASE_URL):undefined;
  private db(){
    if(!this.connection)throw new ServiceUnavailableException('Admin factor DB unavailable');
    return this.connection.db;
  }
  verify(bearer:string){return authenticateUserSession(this.db(),bearer);}
  private key(){
    try{return configuredTotpKeys();}
    catch{throw new ServiceUnavailableException('Admin factor key unavailable');}
  }
  private async checked<T>(work:()=>Promise<T>):Promise<T>{
    try{return await work();}
    catch(error){
      if(error instanceof Error&&error.message==='Administrator factor verification required'){
        throw denied();
      }
      // Keep ciphertext, server secret and internal DB details out of HTTP.
      throw new ServiceUnavailableException('Admin factor unavailable');
    }
  }
  start(bearer:string,requestId:string){
    return this.checked(()=>beginAdminTotpEnrollment(this.db(),bearer,this.key(),requestId));
  }
  confirm(bearer:string,code:string,requestId:string){
    return this.checked(()=>confirmAdminTotpEnrollment(
      this.db(),bearer,code,this.key(),requestId,
    ));
  }
  proof(bearer:string,code:string,requestId:string){
    return this.checked(()=>verifyAdminTotpForSession(
      this.db(),bearer,code,this.key(),requestId,
    ));
  }
  async onModuleDestroy(){await this.connection?.pool.end();}
}

const otpBodyApi={
  type:'object',additionalProperties:false,required:['code'],
  properties:{code:{type:'string',pattern:'^[0-9]{6}$',minLength:6,maxLength:6}},
};
const enrollmentApi={
  type:'object',additionalProperties:false,required:['secretBase32','expiresAt'],
  properties:{
    secretBase32:{type:'string',pattern:'^[A-Z2-7]{32}$'},
    expiresAt:{type:'string',format:'date-time'},
  },
};
const proofApi={
  type:'object',additionalProperties:false,required:['verified','expiresAt'],
  properties:{
    verified:{type:'boolean',enum:[true]},
    expiresAt:{type:'string',format:'date-time'},
  },
};

@ApiTags('admin-mfa')
@ApiBearerAuth('folioSession')
@ApiSecurity('folioWebSession')
@Controller('v1/admin/mfa/totp')
@UseGuards(AdminMfaOptInGuard,VerifiedSelfSessionGuard)
export class AdminTotpController {
  constructor(@Inject(AdminTotpDb) private readonly store:AdminTotpDb){}

  private rejectQuery(query:Record<string,unknown>):void{
    if(Object.keys(query).length)throw new BadRequestException('Unexpected query parameters');
  }
  private trace(request:AdminMfaRequest):string{
    if(!request.requestId)throw new ServiceUnavailableException('Request tracing unavailable');
    if(!request.auth?.userId||!request.auth.sessionId)throw denied();
    return request.requestId;
  }
  private async bearer(request:AdminMfaRequest):Promise<string>{
    const headers=request.headers;
    if(headers?.cookie!==undefined){
      if(process.env.FOLIO_WEB_AUTH_MODE!=='direct-tls-only')throw denied();
      return verifiedWebCookieBearer(request,
        (token:string)=>this.store.verify(token),{
          origin:process.env.FOLIO_WEB_AUTH_ORIGIN,
          csrfKeyHex:process.env.FOLIO_WEB_CSRF_KEY_HEX,
        },request.method??'POST');
    }
    // A browser MUST use HttpOnly cookie + strict Origin/HMAC-CSRF.
    // Native bearer has NO ambient cookie and no browser Origin.
    if(headers?.origin!==undefined||headers?.['sec-fetch-site']!==undefined){
      throw denied();
    }
    const auth=headers?.authorization;
    if(typeof auth!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)){
      throw denied();
    }
    return auth.slice(7);
  }

  @Post('enroll')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Opt-in direct-TLS only pending admin TOTP enrollment; no privilege minted'})
  @ApiBody({required:false,schema:{type:'object',additionalProperties:false}})
  @ApiOkResponse({schema:enrollmentApi})
  async enroll(@Req() request:AdminMfaRequest,
    @Query() query:Record<string,unknown>,@Body() body:unknown){
    this.rejectQuery(query);
    if(body!==undefined&&(typeof body!=='object'||body===null||
      Array.isArray(body)||Object.keys(body).length)){
      throw new BadRequestException('Unexpected enrollment fields');
    }
    const trace=this.trace(request);
    const token=await this.bearer(request);
    return this.store.start(token,trace);
  }

  @Post('confirm')
  @HttpCode(204)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Opt-in verify pending factor with fresh TOTP, without admin elevation'})
  @ApiBody({schema:otpBodyApi})
  @ApiNoContentResponse()
  async confirm(@Req() request:AdminMfaRequest,
    @Query() query:Record<string,unknown>,@Body() rawBody:unknown){
    this.rejectQuery(query);
    const body=adminTotpCodeRequestSchema.safeParse(rawBody);
    if(!body.success)throw new BadRequestException('Invalid TOTP confirmation input');
    const trace=this.trace(request);
    const token=await this.bearer(request);
    await this.store.confirm(token,body.data.code,trace);
  }

  @Post('verify')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Opt-in step-up using unused TOTP to bind MFA to current device'})
  @ApiBody({schema:otpBodyApi})
  @ApiOkResponse({schema:proofApi})
  async verify(@Req() request:AdminMfaRequest,
    @Query() query:Record<string,unknown>,@Body() rawBody:unknown){
    this.rejectQuery(query);
    const body=adminTotpCodeRequestSchema.safeParse(rawBody);
    if(!body.success)throw new BadRequestException('Invalid TOTP verification input');
    const trace=this.trace(request);
    const token=await this.bearer(request);
    return this.store.proof(token,body.data.code,trace);
  }
}

@Module({
  controllers:[AdminTotpController],
  providers:[
    AdminMfaOptInGuard,AdminTotpDb,VerifiedSelfSessionGuard,
    {provide:VERIFIED_SESSION_LOOKUP,
      useFactory:(store:AdminTotpDb):BearerSessionLookup=>(b:string)=>store.verify(b),
      inject:[AdminTotpDb],
    },
  ],
})
export class AdminTotpModule {}
