import {createHash} from 'node:crypto';
import {and,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {
  acceptedTotpStep,ADMIN_MFA_PROOF_MS,decryptTotpSeed,ENROLLMENT_MS,
  newEncryptedTotpSeed,requireTotpKeyring,requireVersionedTotpKey,
  TOTP_LOCK_MS,TOTP_MAX_FAILURES,
} from './admin-totp-crypto.js';
import type {TotpKeyMaterial} from './admin-totp-crypto.js';

type AdminDb=ReturnType<typeof createFolioDb>['db'];
type AdminTx=Parameters<Parameters<AdminDb['transaction']>[0]>[0];
type Principal={userId:string;sessionId:string};
type Factor=typeof schema.adminTotpCredentials.$inferSelect;
const rejected=()=>new Error('Administrator factor verification required');

const trustedTrace=(requestId?:string)=>
  requestId===undefined?undefined:z.uuid().parse(requestId);

/**
 * A signed-in and email-verified ADMIN MEMBER may provision a factor. A
 * password-only session cannot gain permissions from provisioning. All reads
 * acquire account -> session -> role locks, aligned with #30/#43 revocation.
 * This is internal-only: no login/bootstrap/enrollment HTTP endpoint.
 */
async function withMemberSession<T>(
  db:AdminDb,bearer:string,action:(tx:AdminTx,principal:Principal)=>Promise<T>,
):Promise<T>{
  if(typeof bearer!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(bearer)){
    throw rejected();
  }
  const digest=createHash('sha256').update(bearer,'ascii').digest('hex');
  return db.transaction(async tx=>{
    const [hint]=await tx.select({
      id:schema.userSessions.id,userId:schema.userSessions.userId,
    }).from(schema.userSessions)
      .where(eq(schema.userSessions.tokenDigest,digest)).limit(1);
    if(!hint)throw rejected();
    const [user]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,hint.userId)).limit(1).for('share');
    if(!user||user.status!=='active'||!user.emailVerifiedAt)throw rejected();
    const [session]=await tx.select().from(schema.userSessions)
      .where(eq(schema.userSessions.id,hint.id)).limit(1).for('share');
    if(!session||session.userId!==user.id||session.tokenDigest!==digest||
      session.revokedAt||session.expiresAt.getTime()<=Date.now()){
      throw rejected();
    }
    const [role]=await tx.select({role:schema.adminRoleMemberships.role})
      .from(schema.adminRoleMemberships).where(and(
        eq(schema.adminRoleMemberships.userId,user.id),
        isNull(schema.adminRoleMemberships.revokedAt),
      )).limit(1).for('share');
    if(!role)throw rejected();
    return action(tx,{userId:user.id,sessionId:session.id});
  });
}

/** Initial factor enrollment requires an existing, verified admin membership.
 * The 160-bit secret is generated using CSPRNG, encrypted via a 256-bit
 * server-only key and returned once. The returned seed MUST be shown only by
 * a future TLS+CSRF-protected authenticated admin enrollment UI. */
export async function beginAdminTotpEnrollment(
  db:AdminDb,bearer:string,keyMaterial:TotpKeyMaterial,requestId?:string,
):Promise<{secretBase32:string;expiresAt:string}>{
  const trace=trustedTrace(requestId);
  const keyring=requireTotpKeyring(keyMaterial);
  const writeVersion=keyring.activeVersion;
  const encryptionKey=requireVersionedTotpKey(keyring,writeVersion);
  return withMemberSession(db,bearer,async(tx,principal)=>{
    const now=new Date();
    const [old]=await tx.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,principal.userId))
      .limit(1).for('update');
    if(old&&(old.status==='active'||
      (old.pendingExpiresAt&&old.pendingExpiresAt.getTime()>now.getTime()))){
      throw rejected(); // Do not disclose existing 2FA state to callers.
    }
    const generated=newEncryptedTotpSeed(principal.userId,encryptionKey,writeVersion);
    const expiresAt=new Date(now.getTime()+ENROLLMENT_MS);
    const row={
      ...generated.record,status:'pending' as const,
      pendingExpiresAt:expiresAt,enabledAt:null,
      lastAcceptedStep:-1,failedAttempts:0,lockedUntil:null,
      updatedAt:now,
    };
    if(old){
      await tx.update(schema.adminTotpCredentials).set(row)
        .where(eq(schema.adminTotpCredentials.userId,principal.userId));
    }else{
      await tx.insert(schema.adminTotpCredentials).values({
        userId:principal.userId,...row,
      });
    }
    await tx.insert(schema.auditEvents).values({
      actorId:principal.userId,action:'admin.totp.enrollment.started',
      entityType:'user_account',entityId:principal.userId,
      ...(trace?{requestId:trace}:{}),
      afterJson:{status:'pending',expiresAt:expiresAt.toISOString()},
    });
    return {secretBase32:generated.secretBase32,expiresAt:expiresAt.toISOString()};
  });
}

/**
 * Wrong codes consume a DB-persisted attempt. Return a value and only throw
 * AFTER the transaction commits, otherwise the lockout would roll back too.
 * FOR UPDATE serializes all devices against ONE monotonic lastAcceptedStep.
 */
async function checkAndConsume(
  tx:AdminTx,row:Factor,otp:string,keyMaterial:TotpKeyMaterial,now:Date,
):Promise<boolean>{
  if(row.lockedUntil&&row.lockedUntil.getTime()>now.getTime())return false;
  const factorUsable=row.status==='active'||
    (row.status==='pending'&&!!row.pendingExpiresAt&&
      row.pendingExpiresAt.getTime()>now.getTime());
  if(!factorUsable)return false;
  let seed:Buffer;
  try{
    seed=decryptTotpSeed(row.userId,row,
      requireVersionedTotpKey(keyMaterial,row.keyVersion));
  }catch{
    // A missing/rotated server secret is a deployment failure, never a
    // password fallback. It must not reset the login attempt counter.
    throw new Error('TOTP encrypted credential unavailable');
  }
  let accepted:number|null;
  try{
    accepted=acceptedTotpStep(seed,otp,row.lastAcceptedStep,now.getTime());
  }finally{
    seed.fill(0);
  }
  if(accepted===null){
    const attempts=(row.lockedUntil&&row.lockedUntil.getTime()<=now.getTime())
      ?1:Math.min(row.failedAttempts+1,TOTP_MAX_FAILURES);
    await tx.update(schema.adminTotpCredentials).set({
      failedAttempts:attempts,
      lockedUntil:attempts>=TOTP_MAX_FAILURES?
        new Date(now.getTime()+TOTP_LOCK_MS):null,
      updatedAt:now,
    }).where(eq(schema.adminTotpCredentials.userId,row.userId));
    return false;
  }
  await tx.update(schema.adminTotpCredentials).set({
    lastAcceptedStep:accepted,failedAttempts:0,lockedUntil:null,updatedAt:now,
  }).where(eq(schema.adminTotpCredentials.userId,row.userId));
  return true;
}

/** Activates enrollment ONLY after proving a fresh RFC 6238 TOTP. This does
 * NOT issue an admin privilege or session MFA proof; the user must verify a
 * subsequent fresh code in their exact active device session. */
export async function confirmAdminTotpEnrollment(
  db:AdminDb,bearer:string,otp:string,keyMaterial:TotpKeyMaterial,requestId?:string,
):Promise<{enabled:boolean}>{
  const trace=trustedTrace(requestId);
  const keyring=requireTotpKeyring(keyMaterial);
  const success=await withMemberSession(db,bearer,async(tx,principal)=>{
    const [row]=await tx.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,principal.userId))
      .limit(1).for('update');
    if(!row||row.status!=='pending')return false;
    const now=new Date();
    if(!await checkAndConsume(tx,row,otp,keyring,now))return false;
    await tx.update(schema.adminTotpCredentials).set({
      status:'active',pendingExpiresAt:null,enabledAt:now,updatedAt:now,
    }).where(eq(schema.adminTotpCredentials.userId,principal.userId));
    await tx.insert(schema.auditEvents).values({
      actorId:principal.userId,action:'admin.totp.enrollment.confirmed',
      entityType:'user_account',entityId:principal.userId,
      ...(trace?{requestId:trace}:{}),
      afterJson:{status:'active',method:'totp'},
    });
    return true;
  });
  if(!success)throw rejected();
  return {enabled:true};
}

/** The sole normal writer of live TOTP session proofs. After an active
 * encrypted factor accepts a never-before-used step, a proof is bound to
 * exactly THIS session for 15 minutes. Other devices need their own fresh
 * code, and a later role/device revocation invalidates admin permission. */
export async function verifyAdminTotpForSession(
  db:AdminDb,bearer:string,otp:string,keyMaterial:TotpKeyMaterial,requestId?:string,
):Promise<{verified:boolean;expiresAt:string}>{
  const trace=trustedTrace(requestId);
  const keyring=requireTotpKeyring(keyMaterial);
  const result=await withMemberSession(db,bearer,async(tx,principal)=>{
    const [row]=await tx.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,principal.userId))
      .limit(1).for('update');
    if(!row||row.status!=='active')return null;
    const now=new Date();
    if(!await checkAndConsume(tx,row,otp,keyring,now))return null;
    const expiresAt=new Date(now.getTime()+ADMIN_MFA_PROOF_MS);
    await tx.insert(schema.adminSessionMfa).values({
      sessionId:principal.sessionId,userId:principal.userId,
      method:'totp',verifiedAt:now,expiresAt,
    }).onConflictDoUpdate({
      target:schema.adminSessionMfa.sessionId,
      set:{userId:principal.userId,method:'totp',verifiedAt:now,expiresAt},
    });
    await tx.insert(schema.auditEvents).values({
      actorId:principal.userId,action:'admin.mfa.totp.verified',
      entityType:'user_session',entityId:principal.sessionId,
      ...(trace?{requestId:trace}:{}),
      afterJson:{factor:'totp',expiresAt:expiresAt.toISOString()},
    });
    return {verified:true,expiresAt:expiresAt.toISOString()};
  });
  if(!result)throw rejected();
  return result;
}
