import {isIP} from 'node:net';
import {BadRequestException,HttpException,HttpStatus,ServiceUnavailableException} from '@nestjs/common';
import {AuthRateLimitExceeded,consumeAuthAttemptRateLimit} from '@folio/db';
import type {createFolioDb} from '@folio/db';
import {authAttemptRequestSchema} from '@folio/contracts';

type AuthDb=ReturnType<typeof createFolioDb>['db'];
/**
 * The TCP peer is the only authenticated transport source in V1's direct-peer
 * path. NEVER infer a client from X-Forwarded-For, Forwarded, X-Real-IP or
 * user-supplied request data. Behind a proxy this returns the proxy address:
 * real public login MUST remain disabled until an explicit trusted-hop contract.
 */
export interface PeerRequest {
  socket?:{remoteAddress?:string|null|undefined};
  headers?:Record<string,string|string[]|undefined>;
}
export function trustedSocketClientIp(request:PeerRequest):string{
  const raw=request.socket?.remoteAddress;
  if(!raw||isIP(raw)===0){
    throw new ServiceUnavailableException('Verified transport peer unavailable');
  }
  return raw;
}

/**
 * A narrow INTERNAL admission boundary. No public auth route uses it yet.
 * Missing key/DB fails closed; untrusted client identity and sensitive quota
 * dimension are never reflected to the HTTP response or audit.
 */
export async function enforceTrustedSocketAuthAttempt(
  db:AuthDb,request:PeerRequest,rawBody:unknown,serverManagedKeyHex:string|undefined,
):Promise<void>{
  const parsed=authAttemptRequestSchema.safeParse(rawBody);
  if(!parsed.success)throw new BadRequestException('Invalid authentication attempt');
  const ip=trustedSocketClientIp(request);
  if(!serverManagedKeyHex||!/^[a-fA-F0-9]{64}$/.test(serverManagedKeyHex)){
    throw new ServiceUnavailableException('Authentication admission unavailable');
  }
  try{
    await consumeAuthAttemptRateLimit(db,{
      action:parsed.data.action,email:parsed.data.email,
      trustedClientIp:ip,hmacKeyHex:serverManagedKeyHex,
    });
  }catch(error){
    if(error instanceof AuthRateLimitExceeded){
      throw new HttpException('Authentication attempt temporarily limited',HttpStatus.TOO_MANY_REQUESTS);
    }
    // A DB outage must NEVER allow passwords/challenges to be checked.
    throw new ServiceUnavailableException('Authentication admission unavailable');
  }
}
