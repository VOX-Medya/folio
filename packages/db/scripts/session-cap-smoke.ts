import {createHash,randomUUID} from 'node:crypto';
import {and,eq,gt,isNull} from 'drizzle-orm';
import {createFolioDb,registerPendingAccount,verifyAccountEmail,
  signInVerifiedAccount,authenticateUserSession,revokeUserSession,
  MAX_ACTIVE_DEVICE_SESSIONS,schema} from '../src/index.js';

function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio test DB required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Session cap smoke only runs on local Folio folio_test DB');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const email='synthetic-device-cap-'+randomUUID()+'@example.com';
  const password='Synthetic-Device-Cap-Password-2026!';
  try{
    const account=await registerPendingAccount(first.db,email,password);
    await verifyAccountEmail(second.db,account.verificationToken);
    // An expired session is retained for audit, never counted as active.
    const expiredBearer='T'.repeat(43);
    await first.db.insert(schema.userSessions).values({
      userId:account.userId,
      tokenDigest:createHash('sha256').update(expiredBearer,'ascii').digest('hex'),
      deviceLabel:'expired synthetic device',
      expiresAt:new Date('2020-01-01T00:00:00.000Z'),
    });
    check((await authenticateUserSession(second.db,expiredBearer))===null,
      'Expired synthetic session was usable');

    // Two real pools and many credential checks race on the SAME account row.
    const candidates=Array.from({length:MAX_ACTIVE_DEVICE_SESSIONS+4},(_,i)=>
      signInVerifiedAccount(i%2?first.db:second.db,email,password,'test-device-'+i));
    const results=await Promise.allSettled(candidates);
    const admitted=results.flatMap(item=>item.status==='fulfilled'?[item.value]:[]);
    const rejected=results.filter(item=>item.status==='rejected');
    check(admitted.length===MAX_ACTIVE_DEVICE_SESSIONS&&rejected.length===4,
      'Concurrent device logins bypassed active account session cap');
    check(rejected.every(item=>item.status==='rejected'&&
      item.reason instanceof Error&&item.reason.message==='Active device session limit reached'),
      'Excess sessions were not explicitly denied');

    const active=await second.db.select().from(schema.userSessions).where(and(
      eq(schema.userSessions.userId,account.userId),
      isNull(schema.userSessions.revokedAt),
      gt(schema.userSessions.expiresAt,new Date()),
    ));
    check(active.length===MAX_ACTIVE_DEVICE_SESSIONS,
      'DB contained more active sessions than device cap');
    check(admitted.every(entry=>active.some(row=>row.id===entry.sessionId)),
      'Allowed devices did not persist their own session rows');
    const audit=await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorId,account.userId));
    check(audit.filter(item=>item.action==='auth.session.created').length===MAX_ACTIVE_DEVICE_SESSIONS,
      'Rejected session attempts created audit/session records');
    const serialized=JSON.stringify(audit);
    check(!serialized.includes(email)&&!serialized.includes(password)&&
      admitted.every(item=>!serialized.includes(item.sessionToken)),
      'Credential or raw token appeared in session audit');

    const firstToken=admitted[0]?.sessionToken;
    if(!firstToken)throw new Error('Missing approved synthetic token');
    check((await revokeUserSession(second.db,firstToken)).revoked,
      'Per-device revocation did not free capacity');
    check((await authenticateUserSession(first.db,firstToken))===null,
      'Revoked session still worked');
    const replacement=await signInVerifiedAccount(first.db,email,password,'replacement-device');
    check((await authenticateUserSession(second.db,replacement.sessionToken))?.userId===account.userId,
      'A released device slot did not admit a new valid login');
    const after=await first.db.select().from(schema.userSessions).where(and(
      eq(schema.userSessions.userId,account.userId),isNull(schema.userSessions.revokedAt),
      gt(schema.userSessions.expiresAt,new Date()),
    ));
    check(after.length===MAX_ACTIVE_DEVICE_SESSIONS,
      'Replacing one revoked session exceeded the active device cap');
    console.log('SESSION CAP PASS: two-pool concurrent logins max 8 active, 4 rejected without audit, expired excluded, one-device revoke reopens slot, no raw bearer leak. Folio test DB only.');
  }finally{await first.pool.end();await second.pool.end();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
