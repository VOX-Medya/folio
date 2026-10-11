import {
  BadRequestException,Body,Controller,Get,Header,HttpCode,Inject,Injectable,
  Module,NotFoundException,OnModuleDestroy,Post,Req,Res,
  ServiceUnavailableException,UnauthorizedException,
} from '@nestjs/common';
import {ApiAcceptedResponse,ApiBody,ApiNoContentResponse,ApiOperation,ApiTags} from '@nestjs/swagger';
import {
  authenticateUserSession,createFolioDb,revokeVerifiedDeviceSession,
  signInVerifiedAccount,registerOrRenewPendingAccount,verifyAccountEmail,
} from '@folio/db';
import {webLoginRequestSchema,webRegisterRequestSchema,webVerifyEmailRequestSchema} from '@folio/contracts';
import {dispatchVerificationMail,requireVerificationMailConfig} from './verification-mail.js';
import {enforceTrustedSocketAuthAttempt} from '../../common/trusted-auth-admission.js';
import {
  assertSafeWebCsrfBootstrap,assertSafeWebLoginRequest,clearWebSessionCookie,
  issueWebSessionCookie,verifyWebCookieSession,webSessionCsrfToken,
} from '../../common/web-cookie-session.js';
import type {WebCookiePolicy} from '../../common/web-cookie-session.js';

/**
 * OPERATIONAL GATE: routes exist in source but are disabled by default.
 * 'true' is intentionally insufficient. Direct TLS on the application socket
 * is mandatory; an unverified reverse-proxy header never enables the flow.
 */
function requireExplicitDirectTlsOptIn():void {
  if(process.env.FOLIO_WEB_AUTH_MODE!=='direct-tls-only'){
    throw new NotFoundException('Web authentication route unavailable');
  }
}
function policy():WebCookiePolicy{
  return {
    origin:process.env.FOLIO_WEB_AUTH_ORIGIN,
    csrfKeyHex:process.env.FOLIO_WEB_CSRF_KEY_HEX,
  };
}
interface IncomingWebRequest {
  headers?:Record<string,string|string[]|undefined>;
  socket?:{
    encrypted?:boolean|undefined;
    remoteAddress?:string|null|undefined;
  };
  requestId?:string;
}
interface OutgoingWebResponse {setHeader(name:string,value:string):void;}

@Injectable()
class WebAuthDb implements OnModuleDestroy {
  private readonly connection=process.env.DATABASE_URL
    ?createFolioDb(process.env.DATABASE_URL):undefined;

  private db(){
    if(!this.connection)throw new ServiceUnavailableException('Authentication database unavailable');
    return this.connection.db;
  }
  verify(bearer:string){
    return authenticateUserSession(this.db(),bearer);
  }
  async admit(request:IncomingWebRequest,email:string,action:'login'|'register'='login'){
    await enforceTrustedSocketAuthAttempt(
      this.db(),request,{action,email},process.env.FOLIO_AUTH_ABUSE_HMAC_KEY_HEX,
    );
  }
  async register(email:string,password:string){
    try{return await registerOrRenewPendingAccount(this.db(),email,password);}
    catch{throw new ServiceUnavailableException('Registration unavailable');}
  }
  async verifyEmail(token:string){
    try{await verifyAccountEmail(this.db(),token);}
    catch(error){
      if(error instanceof Error&&[
        'Invalid or expired authentication challenge',
        'Email is already verified or unavailable',
      ].includes(error.message)){
        throw new UnauthorizedException('Invalid or expired verification code');
      }
      throw new ServiceUnavailableException('Email verification unavailable');
    }
  }
  async login(email:string,password:string,requestId:string){
    try{
      // Device label and request correlation are server-owned. The raw
      // x-request-id client header is never passed into the database.
      return await signInVerifiedAccount(this.db(),email,password,'web',requestId);
    }catch(error){
      if(error instanceof Error&&[
        'Invalid login credentials or unavailable account',
        'Active device session limit reached',
      ].includes(error.message)){
        // The existence, verification state and device count of an account
        // are not disclosed to an unauthenticated caller.
        throw new UnauthorizedException('Invalid email or password');
      }
      throw new ServiceUnavailableException('Authentication unavailable');
    }
  }
  async logout(userId:string,sessionId:string,requestId?:string){
    try{
      const result=await revokeVerifiedDeviceSession(
        this.db(),userId,sessionId,sessionId,requestId,
      );
      if(!result.found)throw new UnauthorizedException('Verified web session required');
    }catch(error){
      if(error instanceof UnauthorizedException)throw error;
      if(error instanceof Error&&error.message==='Verified session required'){
        throw new UnauthorizedException('Verified web session required');
      }
      throw new ServiceUnavailableException('Web logout unavailable');
    }
  }
  async onModuleDestroy():Promise<void>{await this.connection?.pool.end();}
}

@ApiTags('auth')
@Controller('v1/auth/web')
export class WebAuthController {
  constructor(@Inject(WebAuthDb) private readonly store:WebAuthDb){}

  @Post('register')
  @HttpCode(202)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Opt-in HTTPS signup; send one-use email challenge, never return token'})
  @ApiBody({schema:{type:'object',additionalProperties:false,
    required:['email','password'],
    properties:{email:{type:'string',format:'email',maxLength:254},
      password:{type:'string',minLength:12,maxLength:128}}}})
  @ApiAcceptedResponse({description:'Generic acceptance, regardless of existing account'})
  async register(@Req() request:IncomingWebRequest,@Body() rawBody:unknown):Promise<void>{
    requireExplicitDirectTlsOptIn();
    assertSafeWebLoginRequest(request,policy());
    const input=webRegisterRequestSchema.safeParse(rawBody);
    if(!input.success)throw new BadRequestException('Invalid registration request');
    let mailConfig:ReturnType<typeof requireVerificationMailConfig>;
    try{mailConfig=requireVerificationMailConfig(process.env);}
    catch{throw new ServiceUnavailableException('Registration unavailable');}
    await this.store.admit(request,input.data.email,'register');
    const pending=await this.store.register(input.data.email,input.data.password);
    if(pending){
      try{await dispatchVerificationMail(input.data.email,pending.verificationToken,mailConfig);}
      catch{throw new ServiceUnavailableException('Registration unavailable');}
    }
  }

  @Post('verify-email')
  @HttpCode(204)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Activate account using single-use emailed code over direct HTTPS'})
  @ApiBody({schema:{type:'object',additionalProperties:false,required:['token'],
    properties:{token:{type:'string',minLength:43,maxLength:43}}}})
  @ApiNoContentResponse()
  async verifyEmail(@Req() request:IncomingWebRequest,@Body() rawBody:unknown):Promise<void>{
    requireExplicitDirectTlsOptIn();
    assertSafeWebLoginRequest(request,policy());
    const input=webVerifyEmailRequestSchema.safeParse(rawBody);
    if(!input.success)throw new BadRequestException('Invalid verification request');
    await this.store.verifyEmail(input.data.token);
  }

  @Post('login')
  @HttpCode(204)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Gated direct-TLS only web login (disabled unless explicitly configured)'})
  @ApiBody({schema:{type:'object',required:['email','password'],
    properties:{
      email:{type:'string',format:'email',maxLength:254},
      password:{type:'string',minLength:12,maxLength:128},
    }}})
  @ApiNoContentResponse()
  async login(@Req() request:IncomingWebRequest,@Body() rawBody:unknown,
    @Res({passthrough:true}) response:OutgoingWebResponse):Promise<void>{
    requireExplicitDirectTlsOptIn();
    // CRITICAL: check TLS, CSRF login origin, secrets and credential crossover
    // BEFORE rate quota, password hashing, or creation of any session.
    const effectivePolicy=policy();
    assertSafeWebLoginRequest(request,effectivePolicy);
    const input=webLoginRequestSchema.safeParse(rawBody);
    if(!input.success)throw new BadRequestException('Invalid login request');
    // Do not mint a credential without the server-side request/audit link.
    // RequestIdMiddleware always sets this before a production controller runs.
    const requestId=request.requestId;
    if(!requestId)throw new ServiceUnavailableException('Request tracing unavailable');
    await this.store.admit(request,input.data.email);
    const session=await this.store.login(input.data.email,input.data.password,requestId);
    // No session token in JSON, response headers except Secure/HttpOnly cookie,
    // or audit. This helper validates the same exact-origin TLS policy again.
    response.setHeader('Set-Cookie',
      issueWebSessionCookie(request,session.sessionToken,effectivePolicy));
  }

  @Get('csrf')
  @HttpCode(204)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'Bootstrap HMAC CSRF header for a verified HTTPS web cookie'})
  @ApiNoContentResponse()
  async csrf(@Req() request:IncomingWebRequest,
    @Res({passthrough:true}) response:OutgoingWebResponse):Promise<void>{
    requireExplicitDirectTlsOptIn();
    const effectivePolicy=policy();
    assertSafeWebCsrfBootstrap(request,effectivePolicy);
    try{
      const token=await webSessionCsrfToken(request,
        (bearer:string)=>this.store.verify(bearer),effectivePolicy);
      response.setHeader('X-Folio-CSRF',token);
    }catch(error){
      // A remotely revoked/disabled or malformed cookie must not trap the
      // browser in a login loop: login deliberately rejects existing cookies.
      // This runs only after direct TLS + exact same-origin CSRF proof. Never
      // retire a cookie for a cross-site request or an unavailable database.
      if(error instanceof UnauthorizedException){
        response.setHeader('Set-Cookie',clearWebSessionCookie(request));
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control','private, no-store')
  @ApiOperation({summary:'CSRF-protected logout for exactly the current web device'})
  @ApiNoContentResponse()
  async logout(@Req() request:IncomingWebRequest,
    @Res({passthrough:true}) response:OutgoingWebResponse):Promise<void>{
    requireExplicitDirectTlsOptIn();
    const identity=await verifyWebCookieSession(request,
      (bearer:string)=>this.store.verify(bearer),policy(),'POST');
    await this.store.logout(identity.userId,identity.sessionId,request.requestId);
    response.setHeader('Set-Cookie',clearWebSessionCookie(request));
  }
}

@Module({controllers:[WebAuthController],providers:[WebAuthDb]})
export class WebAuthModule {}
