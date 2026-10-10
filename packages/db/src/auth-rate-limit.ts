import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type RateDb=ReturnType<typeof createFolioDb>['db'];
const WINDOW_MS=15*60*1000;
const policies={
  login:{account:5,network:30},
  signup:{account:3,network:20},
  reset:{account:3,network:20},
} as const;
const inputSchema=z.object({
  action:z.enum(['login','signup','reset']),
  email:z.email().trim().max(254),
  networkIp:z.string().min(2).max(45),
  // Required secret must come from a trusted server-side configuration,
  // NEVER a browser-supplied header or committed .env file.
  hmacKeyHex:z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

type Action=keyof typeof policies;
type Scope='account'|'network';
type AuthAttempt=z.infer<typeof inputSchema>;
function canonicalIp(raw:string):string {
  if(isIP(raw)===4)return raw;
  if(isIP(raw)===6)return new URL('http://['+raw+']/').hostname.toLowerCase();
  throw new Error('Untrusted network identifier is not a valid IP address');
}
function bucket(input:AuthAttempt,scope:Scope){
  const value=scope==='account'?input.email.toLowerCase():canonicalIp(input.networkIp);
  const digest=createHmac('sha256',Buffer.from(input.hmacKeyHex,'hex'))
    .update('folio-auth-v1|'+input.action+'|'+scope+'|'+value).digest('hex');
  return {bucketDigest:digest,scope,action:input.action as Action,
    limit:policies[input.action][scope]};
}

/**
 * Auth ABUSE gate: BOTH email-identity and socket-remote-IP buckets.
 * No raw email or IP is persisted. Call BEFORE password hashing or email
 * challenge issuance, after deriving remote IP from a trusted socket.
 *
 * This is not a public endpoint or HTTP middleware until server trust/proxy
 * handling and secret rotation are configured. Missing HMAC key FAILS CLOSED.
 */
export async function admitAuthAttempt(db:RateDb,raw:unknown,serverNow:Date=new Date()){
  const parsed=inputSchema.parse(raw);
  if(!Number.isFinite(serverNow.getTime()))throw new Error('Invalid server clock');
  const scopes=[bucket(parsed,'account'),bucket(parsed,'network')]
    .sort((left,right)=>left.bucketDigest.localeCompare(right.bucketDigest,'en'));
  return db.transaction(async tx=>{
    let allowed=true,retryAfterSeconds=0;
    for(const policy of scopes){
      await tx.insert(schema.authRateBuckets).values({
        bucketDigest:policy.bucketDigest,action:policy.action,scope:policy.scope,
        attempts:0,windowStartedAt:serverNow,
      }).onConflictDoNothing();
      const [current]=await tx.select().from(schema.authRateBuckets)
        .where(eq(schema.authRateBuckets.bucketDigest,policy.bucketDigest))
        .limit(1).for('update');
      if(!current)throw new Error('Authentication rate bucket missing');
      const resetWindow=serverNow.getTime()-current.windowStartedAt.getTime()>=WINDOW_MS;
      const attempts=(resetWindow?0:current.attempts)+1;
      let blockedUntil=current.blockedUntil;
      const existingBlock=!!blockedUntil&&blockedUntil.getTime()>serverNow.getTime();
      if(attempts>policy.limit){
        const nextBlock=new Date(serverNow.getTime()+WINDOW_MS);
        if(!blockedUntil||blockedUntil.getTime()<nextBlock.getTime())blockedUntil=nextBlock;
      }
      const denied=existingBlock||attempts>policy.limit;
      if(denied){
        allowed=false;
        retryAfterSeconds=Math.max(retryAfterSeconds,
          Math.ceil(((blockedUntil?.getTime()??serverNow.getTime())-serverNow.getTime())/1000));
      }
      await tx.update(schema.authRateBuckets).set({
        attempts,windowStartedAt:resetWindow?serverNow:current.windowStartedAt,
        blockedUntil:blockedUntil&&blockedUntil.getTime()>serverNow.getTime()?blockedUntil:null,
        updatedAt:serverNow,
      }).where(eq(schema.authRateBuckets.bucketDigest,policy.bucketDigest));
    }
    return {allowed,retryAfterSeconds:Math.max(0,retryAfterSeconds)};
  });
}
