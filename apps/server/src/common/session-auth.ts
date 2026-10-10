import {
  CanActivate,ExecutionContext,Inject,Injectable,
  ServiceUnavailableException,UnauthorizedException,
} from '@nestjs/common';
import {assertSafeWebCsrfBootstrap,verifyWebCookieSession} from './web-cookie-session.js';

/** Trusted session lookups must query user_sessions via authenticateUserSession. */
export type SessionPrincipal={userId:string;sessionId:string};
export type BearerSessionLookup=(bearer:string)=>Promise<SessionPrincipal|null>;
export const VERIFIED_SESSION_LOOKUP=Symbol('folio.verified.session.lookup');

interface FolioSessionRequest {
  headers?:{authorization?:string|string[]};
  auth?:SessionPrincipal;
}

/**
 * A guard, not an unguarded authentication endpoint.
 * It never trusts x-user-id/x-admin-role and NEVER populates adminRoles.
 * Production routes must explicitly opt in AND install a trusted DB resolver.
 */
@Injectable()
export class VerifiedSessionGuard implements CanActivate {
  constructor(@Inject(VERIFIED_SESSION_LOOKUP) private readonly lookup:BearerSessionLookup){}
  async canActivate(context:ExecutionContext):Promise<boolean>{
    const request=context.switchToHttp().getRequest<FolioSessionRequest>();
    // Never inherit a principal supplied by a client or another middleware.
    delete request.auth;
    const header=request.headers?.authorization;
    if(typeof header!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)){
      throw new UnauthorizedException('Verified session required');
    }
    let principal:SessionPrincipal|null;
    try{principal=await this.lookup(header.slice(7));}
    catch{
      throw new ServiceUnavailableException('Session verification unavailable');
    }
    if(!principal?.userId||!principal.sessionId){
      throw new UnauthorizedException('Verified session required');
    }
    request.auth={userId:principal.userId,sessionId:principal.sessionId};
    return true;
  }
}


/**
 * V1 self-service endpoint transport switch.
 * Native API: one verified Authorization bearer and NO Cookie.
 * Web API: one HttpOnly session cookie, actual application TLS, configured
 * exact Origin, and mandatory CSRF on PATCH/POST/DELETE.
 * The two transports must never be mixed. This does not grant admin rights.
 */
interface SelfSessionRequest {
  headers?:Record<string,string|string[]|undefined>;
  socket?:{encrypted?:boolean|undefined};
  method?:string;
  auth?:SessionPrincipal;
}

@Injectable()
export class VerifiedSelfSessionGuard implements CanActivate {
  constructor(@Inject(VERIFIED_SESSION_LOOKUP) private readonly lookup:BearerSessionLookup){}
  async canActivate(context:ExecutionContext):Promise<boolean>{
    const request=context.switchToHttp().getRequest<SelfSessionRequest>();
    delete request.auth;
    const headers=request.headers;
    if(headers?.cookie!==undefined){
      if(process.env.FOLIO_WEB_AUTH_MODE!=='direct-tls-only'){
        throw new UnauthorizedException('Verified session required');
      }
      const policy={
        origin:process.env.FOLIO_WEB_AUTH_ORIGIN,
        csrfKeyHex:process.env.FOLIO_WEB_CSRF_KEY_HEX,
      };
      // GET responses also reject cross-site bootstrap and fetch metadata.
      // Unsafe methods additionally require exact Origin + HMAC-CSRF.
      assertSafeWebCsrfBootstrap(request,policy);
      const principal=await verifyWebCookieSession(
        request,this.lookup,policy,request.method??'GET',
      );
      request.auth=principal;
      return true;
    }
    const header=headers?.authorization;
    if(typeof header!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)){
      throw new UnauthorizedException('Verified session required');
    }
    let principal:SessionPrincipal|null;
    try{principal=await this.lookup(header.slice(7));}
    catch{throw new ServiceUnavailableException('Session verification unavailable');}
    if(!principal?.userId||!principal.sessionId){
      throw new UnauthorizedException('Verified session required');
    }
    request.auth={userId:principal.userId,sessionId:principal.sessionId};
    return true;
  }
}
