import {CanActivate,ExecutionContext,Inject,Injectable,OnModuleDestroy,UnauthorizedException} from '@nestjs/common';
import {createFolioDb,authenticateUserSession} from '@folio/db';

/**
 * Session lookup is isolated behind an injectable service so HTTP tests can
 * exercise the real guard with synthetic tokens without a public auth route.
 */
@Injectable()
export class FolioSessionVerifier implements OnModuleDestroy {
  private readonly connection=process.env.DATABASE_URL
    ?createFolioDb(process.env.DATABASE_URL):null;

  async verify(rawToken:string):Promise<{userId:string;sessionId:string}|null>{
    if(!this.connection)return null;
    try{return await authenticateUserSession(this.connection.db,rawToken);}
    catch{return null;}
  }
  async onModuleDestroy():Promise<void>{await this.connection?.pool.end();}
}

interface SessionRequest {
  headers:Record<string,string|string[]|undefined>;
  auth?:{userId:string;sessionId:string};
}

@Injectable()
export class VerifiedBearerSessionGuard implements CanActivate {
  constructor(@Inject(FolioSessionVerifier) private readonly verifier:FolioSessionVerifier){}
  async canActivate(context:ExecutionContext):Promise<boolean>{
    const request=context.switchToHttp().getRequest<SessionRequest>();
    // Never merge an untrusted request.auth or x-user-id / x-admin-role into
    // the verified identity. Admin roles require a separate trusted DB lookup.
    delete request.auth;
    const header=request.headers.authorization;
    if(typeof header!=='string')throw new UnauthorizedException('Verified session required');
    const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if(!match)throw new UnauthorizedException('Verified session required');
    const principal=await this.verifier.verify(match[1]!);
    if(!principal)throw new UnauthorizedException('Verified session required');
    request.auth={userId:principal.userId,sessionId:principal.sessionId};
    return true;
  }
}
