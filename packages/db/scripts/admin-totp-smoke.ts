import {randomBytes,randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {
  beginAdminTotpEnrollment,confirmAdminTotpEnrollment,createFolioDb,
  registerPendingAccount,verifyAccountEmail,signInVerifiedAccount,
  verifyAdminTotpForSession,withVerifiedAdminPermission,revokeUserSession,schema,
} from '../src/index.js';
import {decodeTotpBase32,totpCodeAtStep} from '../src/admin-totp-crypto.js';

function check(value:unknown,message:string):asserts value{
  if(!value)throw new Error(message);
}
async function denied(work:()=>Promise<unknown>,message:string){
  let stopped=false;
  try{await work();}catch{stopped=true;}
  if(!stopped)throw new Error(message);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit isolated test DB required');
  const target=new URL(url);
  if(target.pathname!=='/folio_test'||
    !['127.0.0.1','localhost'].includes(target.hostname)||
    target.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Real TOTP tests must use Folio-only loopback folio_test');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const password='Synthetic-Admin-TOTP-Password-2026!';
  const keyHex=randomBytes(32).toString('hex'); // ephemeral CI test key only
  const wrongKeyHex=randomBytes(32).toString('hex');
  const email='totp-member-'+randomUUID()+'@example.com';
  const req=randomUUID();
  try{
    const account=await registerPendingAccount(first.db,email,password);
    await verifyAccountEmail(second.db,account.verificationToken);
    const web=await signInVerifiedAccount(first.db,email,password,'web-admin-test');
    const android=await signInVerifiedAccount(second.db,email,password,'android-admin-test');
    const manager=await registerPendingAccount(first.db,
      'synthetic-totp-role-granter-'+randomUUID()+'@example.com',password);
    await verifyAccountEmail(second.db,manager.verificationToken);

    await denied(()=>beginAdminTotpEnrollment(first.db,web.sessionToken,keyHex,req),
      'Ordinary user password session enrolled a privileged TOTP factor');
    await denied(()=>verifyAdminTotpForSession(first.db,web.sessionToken,
      '123456',keyHex,req),'Ordinary user received MFA session proof');
    await first.db.insert(schema.adminRoleMemberships).values({
      userId:account.userId,role:'rights',grantedBy:manager.userId,
    });
    await denied(()=>withVerifiedAdminPermission(first.db,web.sessionToken,
      'rights:review',async()=>true),
      'Admin role without OTP obtained authorization');

    await denied(()=>beginAdminTotpEnrollment(first.db,web.sessionToken,
      'not-a-valid-256-bit-secret',req),'Missing encryption key allowed enrollment');
    let factorRows=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,account.userId));
    check(factorRows.length===0,'Invalid encryption key persisted partial TOTP enrollment');
    await denied(()=>beginAdminTotpEnrollment(first.db,web.sessionToken,
      keyHex,'client-controlled-request-id'),'Client chosen malformed trace accepted');

    const started=await beginAdminTotpEnrollment(first.db,web.sessionToken,keyHex,req);
    check(started.secretBase32.length===32,'Generated TOTP seed was not 160-bit base32');
    check(new Date(started.expiresAt).getTime()>Date.now(),'Enrollment lacks expiry');
    const seed=decodeTotpBase32(started.secretBase32);
    factorRows=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,account.userId));
    const initial=factorRows[0];
    check(!!initial&&initial.status==='pending'&&initial.lastAcceptedStep===-1&&
      initial.failedAttempts===0&&
      !JSON.stringify(initial).includes(started.secretBase32),
      'Unverified TOTP factor was activated or stored as plaintext');
    await denied(()=>beginAdminTotpEnrollment(second.db,android.sessionToken,keyHex,req),
      'A second device silently replaced active enrollment seed');
    await denied(()=>verifyAdminTotpForSession(first.db,web.sessionToken,
      '000000',keyHex,req),'Pending TOTP factor granted session MFA');

    // Lockout MUST survive a rejected transaction. The sixth (even correct)
    // attempt remains forbidden until the 15m window expires.
    for(let count=1;count<=5;count++){
      await denied(()=>confirmAdminTotpEnrollment(first.db,web.sessionToken,
        'wrong-code',keyHex,req),'Invalid TOTP enrollment code was accepted');
      const [state]=await first.db.select().from(schema.adminTotpCredentials)
        .where(eq(schema.adminTotpCredentials.userId,account.userId));
      check(state?.failedAttempts===count,
        'Rejected TOTP attempt rolled back its persistent failure counter');
    }
    const [locked]=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,account.userId));
    check(!!locked?.lockedUntil&&locked.lockedUntil.getTime()>Date.now(),
      'Five invalid codes did not create a persistent lock');
    const nowStep=Math.floor(Date.now()/30_000);
    await denied(()=>confirmAdminTotpEnrollment(first.db,web.sessionToken,
      totpCodeAtStep(seed,nowStep),keyHex,req),
      'Correct TOTP bypassed locked factor');
    // This is an isolated test-only simulation of a completed lockout timer.
    // No recovery/unlock API is exposed to production callers.
    await first.db.update(schema.adminTotpCredentials).set({
      failedAttempts:0,lockedUntil:null,
    }).where(eq(schema.adminTotpCredentials.userId,account.userId));

    await denied(()=>confirmAdminTotpEnrollment(first.db,web.sessionToken,
      totpCodeAtStep(seed,Math.floor(Date.now()/30_000)),wrongKeyHex,req),
      'Incorrect server-side encryption key successfully confirmed factor');
    const confirmStep=Math.floor(Date.now()/30_000);
    const confirmed=await confirmAdminTotpEnrollment(first.db,web.sessionToken,
      totpCodeAtStep(seed,confirmStep),keyHex,req);
    check(confirmed.enabled,'Real RFC6238 code did not enable encrypted factor');
    const [active]=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,account.userId));
    check(active?.status==='active'&&!!active.enabledAt&&
      active.pendingExpiresAt===null&&active.lastAcceptedStep===confirmStep,
      'Verified enrollment status/replay fence not atomically stored');
    await denied(()=>beginAdminTotpEnrollment(first.db,web.sessionToken,keyHex,req),
      'Enabled factor could be overwritten with a new secret');
    await denied(()=>confirmAdminTotpEnrollment(first.db,web.sessionToken,
      totpCodeAtStep(seed,confirmStep),keyHex,req),
      'Confirmed OTP enrollment was replayable');
    const beforeProof=await first.db.select().from(schema.adminSessionMfa)
      .where(eq(schema.adminSessionMfa.userId,account.userId));
    check(beforeProof.length===0,'Enrollment confirmation secretly minted MFA privilege');
    await denied(()=>withVerifiedAdminPermission(first.db,web.sessionToken,
      'rights:review',async()=>true),
      'Enrolled factor alone elevated an unverified device');

    // One currently acceptable unused code can be claimed by ONLY ONE of
    // two verified account devices, even across two real DB connection pools.
    const raceStep=Math.max(confirmStep+1,Math.floor(Date.now()/30_000));
    const freshCode=totpCodeAtStep(seed,raceStep);
    const raced=await Promise.allSettled([
      verifyAdminTotpForSession(first.db,web.sessionToken,freshCode,keyHex,req),
      verifyAdminTotpForSession(second.db,android.sessionToken,freshCode,keyHex,randomUUID()),
    ]);
    check(raced.filter(x=>x.status==='fulfilled').length===1&&
      raced.filter(x=>x.status==='rejected').length===1,
      'One TOTP time step was accepted on multiple devices');
    const winner=raced[0]?.status==='fulfilled'?web:android;
    const loser=raced[0]?.status==='fulfilled'?android:web;
    const [currentProof]=await first.db.select().from(schema.adminSessionMfa)
      .where(eq(schema.adminSessionMfa.sessionId,winner.sessionId));
    const [otherProof]=await first.db.select().from(schema.adminSessionMfa)
      .where(eq(schema.adminSessionMfa.sessionId,loser.sessionId));
    check(currentProof?.userId===account.userId&&currentProof.method==='totp'&&
      currentProof.expiresAt.getTime()>Date.now()&&
      currentProof.expiresAt.getTime()-currentProof.verifiedAt.getTime()===15*60_000&&
      !otherProof,
      'TOTP verification produced missing, wrong-device or long-lived MFA proof');
    check(await withVerifiedAdminPermission(first.db,winner.sessionToken,
      'rights:review',async()=>true),
      'Genuine MFA proof could not authorize the matching device');
    await denied(()=>withVerifiedAdminPermission(first.db,loser.sessionToken,
      'rights:review',async()=>true),
      'Unverified second device borrowed a TOTP proof');
    await denied(()=>verifyAdminTotpForSession(first.db,winner.sessionToken,
      freshCode,keyHex,req),'Fresh code was replayed on the same device');
    await denied(()=>withVerifiedAdminPermission(first.db,winner.sessionToken,
      'personal:book:read',async()=>true),
      'MFA enabled private user book access');

    const audit=await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorId,account.userId));
    check(audit.filter(a=>a.action==='admin.totp.enrollment.started').length===1&&
      audit.filter(a=>a.action==='admin.totp.enrollment.confirmed').length===1&&
      audit.filter(a=>a.action==='admin.mfa.totp.verified').length===1,
      'TOTP enrollment, proof and replay did not preserve audit uniqueness');
    const auditText=JSON.stringify(audit);
    for(const forbidden of [started.secretBase32,freshCode,password,email,
      web.sessionToken,android.sessionToken,keyHex]){
      check(!auditText.includes(forbidden),'TOTP secret or raw bearer leaked into audit');
    }
    await first.db.update(schema.adminRoleMemberships).set({revokedAt:new Date()})
      .where(and(eq(schema.adminRoleMemberships.userId,account.userId),
        eq(schema.adminRoleMemberships.role,'rights')));
    await denied(()=>withVerifiedAdminPermission(first.db,winner.sessionToken,
      'rights:review',async()=>true),
      'Revoked role kept admin access after authentic TOTP');
    check((await revokeUserSession(second.db,winner.sessionToken)).revoked,
      'Verified TOTP device could not be revoked');
    await denied(()=>withVerifiedAdminPermission(first.db,winner.sessionToken,
      'rights:review',async()=>true),
      'Revoked device retained privileged access');
    console.log('ADMIN TOTP PASS: encrypted 160-bit seed, real SHA1 TOTP enrollment, wrong-key denial, DB 5-attempt lockout, cross-device time-step replay fence, 15m exact-device proof, no private access, rollback-safe audit and revoke. Folio test DB only; no public MFA route.');
  }finally{await first.pool.end();await second.pool.end();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
