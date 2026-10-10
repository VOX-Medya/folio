import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createFolioDb,registerPendingAccount,verifyAccountEmail,
  issuePasswordResetChallenge,resetAccountPassword,signInVerifiedAccount,
  authenticateUserSession,revokeUserSession,revokeAllUserSessions,schema} from '../src/index.js';

function requireState(value:unknown,message:string):asserts value {
  if(!value)throw new Error(message);
}
async function denied(work:()=>Promise<unknown>,message:string):Promise<void>{
  let blocked=false;
  try{await work();}catch{blocked=true;}
  requireState(blocked,message);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit local Folio test DB is required');
  const target=new URL(url);
  if(target.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(target.hostname)||
    target.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Auth tests require isolated Folio loopback folio_test');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const email='synthetic-'+randomUUID()+'@example.com';
  const pass='S3cure!Synthetic-Password-2026';
  const updated='N3w!Synthetic-Password-2026';
  try{
    const registered=await registerPendingAccount(first.db,email.toUpperCase(),pass);
    requireState(registered.verificationToken.length===43,'No one-time verification challenge');
    const [account]=await first.db.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,registered.userId));
    const [credential]=await first.db.select().from(schema.passwordCredentials)
      .where(eq(schema.passwordCredentials.userId,registered.userId));
    requireState(account?.status==='pending_email'&&!account.emailVerifiedAt,
      'New account was enabled without email verification');
    requireState(credential?.scheme==='scrypt-v1'&&credential.passwordDigest.length===128&&
      credential.passwordSalt.length===32&&credential.passwordDigest!==pass,
      'Password not stored as salted slow hash');
    await denied(()=>signInVerifiedAccount(first.db,email,pass,'web'),
      'Unverified account obtained session');
    const preReset=await issuePasswordResetChallenge(first.db,email);
    requireState(preReset===null,'Unverified account obtained password recovery token');
    await denied(()=>verifyAccountEmail(first.db,'Z'.repeat(43)),
      'Forged verification challenge accepted');

    // Concurrency: two real DB connections cannot consume same email token twice.
    const raced=await Promise.allSettled([
      verifyAccountEmail(first.db,registered.verificationToken),
      verifyAccountEmail(second.db,registered.verificationToken),
    ]);
    requireState(raced.filter(item=>item.status==='fulfilled').length===1&&
      raced.filter(item=>item.status==='rejected').length===1,
      'Email token replay race was not serialized');
    const [verified]=await first.db.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,registered.userId));
    requireState(verified?.status==='active'&&!!verified.emailVerifiedAt,
      'Verified account was not activated');
    await denied(()=>verifyAccountEmail(first.db,registered.verificationToken),
      'Consumed email challenge replayed');

    await denied(()=>signInVerifiedAccount(first.db,email,'Invalid-Password-2026','web'),
      'Incorrect password started a session');
    await denied(()=>signInVerifiedAccount(first.db,'nobody-'+randomUUID()+'@example.com',pass,'web'),
      'Nonexistent account started a session');
    await denied(()=>signInVerifiedAccount(first.db,email,pass,'web','client-spoofed-id'),
      'Malformed programmatic request ID was accepted for a verified session');
    const web=await signInVerifiedAccount(first.db,email,pass,'web');
    const android=await signInVerifiedAccount(second.db,email,pass,'android');
    requireState(web.sessionToken!==android.sessionToken&&web.userId===android.userId,
      'Device sessions lack identity separation');
    requireState((await authenticateUserSession(second.db,web.sessionToken))?.userId===registered.userId,
      'Hashed bearer session does not resolve verified user');
    requireState(await authenticateUserSession(first.db,'x-admin-role-superadmin')===null,
      'Header-style identity spoof resolved a user');
    const [persisted]=await first.db.select().from(schema.userSessions)
      .where(eq(schema.userSessions.id,web.sessionId));
    requireState(persisted?.tokenDigest.length===64&&
      persisted.tokenDigest!==web.sessionToken,'Raw bearer token persisted');

    requireState((await revokeUserSession(second.db,web.sessionToken)).revoked,
      'Session could not be revoked');
    requireState(!(await revokeUserSession(first.db,web.sessionToken)).revoked,
      'Duplicate revocation should be an idempotent no-op');
    requireState((await authenticateUserSession(first.db,web.sessionToken))===null,
      'Revoked web session still accepted');
    requireState((await authenticateUserSession(first.db,android.sessionToken))?.userId===registered.userId,
      'Per-device revoke wrongly invalidated other active devices');

    // Password reset challenge supersession, all-session revocation and replay.
    const reset1=await issuePasswordResetChallenge(first.db,email);
    const reset2=await issuePasswordResetChallenge(second.db,email);
    requireState(!!reset1&&!!reset2,'Verified account cannot start password reset');
    await denied(()=>resetAccountPassword(first.db,reset1.resetToken,updated),
      'Old superseded reset challenge accepted');
    const resetRace=await Promise.allSettled([
      resetAccountPassword(first.db,reset2.resetToken,updated),
      resetAccountPassword(second.db,reset2.resetToken,updated),
    ]);
    requireState(resetRace.filter(item=>item.status==='fulfilled').length===1&&
      resetRace.filter(item=>item.status==='rejected').length===1,
      'Password reset challenge was reused concurrently');
    requireState((await authenticateUserSession(second.db,android.sessionToken))===null,
      'Password reset failed to invalidate Android session');
    await denied(()=>signInVerifiedAccount(first.db,email,pass,'web'),
      'Old password accepted after reset');
    const renewed=await signInVerifiedAccount(first.db,email,updated,'web');
    const another=await signInVerifiedAccount(second.db,email,updated,'tablet');
    requireState((await revokeAllUserSessions(second.db,renewed.sessionToken)).revoked,
      'All-device revoke failed');
    requireState((await authenticateUserSession(first.db,another.sessionToken))===null&&
      (await authenticateUserSession(first.db,renewed.sessionToken))===null,
      'Session family was not revoked');
    await denied(()=>revokeAllUserSessions(first.db,renewed.sessionToken),
      'Revoked token could revoke sessions again');

    // Even a recently issued, correct bearer cannot authenticate a disabled account.
    const latest=await signInVerifiedAccount(first.db,email,updated,'web');
    await first.db.update(schema.userAccounts).set({status:'disabled'})
      .where(eq(schema.userAccounts.id,registered.userId));
    requireState((await authenticateUserSession(second.db,latest.sessionToken))===null,
      'Disabled user retained access');
    await denied(()=>signInVerifiedAccount(first.db,email,updated,'web'),
      'Disabled user could sign in');

    const audit=await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorId,registered.userId));
    const auditText=JSON.stringify(audit);
    requireState(audit.some(item=>item.action==='auth.email.verified')&&
      audit.some(item=>item.action==='auth.password.reset')&&
      audit.some(item=>item.action==='auth.sessions.revoke_all'),
      'Auth audit events were incomplete');
    for(const forbidden of [pass,updated,email,registered.verificationToken,
      reset1.resetToken,reset2.resetToken,web.sessionToken,android.sessionToken]){
      requireState(!auditText.includes(forbidden),'Sensitive secret leaked into audit log');
    }
    console.log('AUTH PASS: pending->verified, salted scrypt, 2-pool single-use challenges/reset, 2 devices, hashed sessions, revoke/all devices, disabled account, secret-free audits. No public routes.');
  }finally{
    await first.pool.end();await second.pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
