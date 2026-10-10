import {createHash} from 'node:crypto';
import {and,eq,isNull} from 'drizzle-orm';
import {adminPermissions,hasAdminPermission} from '@folio/contracts';
import type {AdminPermission} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type AdminDb=ReturnType<typeof createFolioDb>['db'];
type AdminTx=Parameters<Parameters<AdminDb['transaction']>[0]>[0];

export type VerifiedAdminIdentity={
  userId:string;
  sessionId:string;
};

/**
 * Internal-only administrator boundary for future secured domain operations.
 *
 * No live admin HTTP route or first-superadmin provisioning exists. An
 * internal, audited AES-GCM/TOTP verifier (#30) can mint a device proof only
 * after a fresh OTP; ordinary login NEVER grants administrator access.
 * The proof alone never bypasses persistent role permission checks.
 *
 * The authorized callback runs inside the SAME transaction as account,
 * session, MFA and role locks. Future admin writes must not authorize with a
 * guard and then perform a separate unaudited transaction (TOCTOU).
 * No HTTP controller, bootstrap grant, or browser token transport is exposed.
 */
export async function withVerifiedAdminPermission<T>(
  db:AdminDb,rawBearer:string,permission:AdminPermission,
  action:(tx:AdminTx,identity:VerifiedAdminIdentity)=>Promise<T>,
  // A detail reader may request one REPEATABLE READ snapshot for every
  // relationship SELECT. The same persisted MFA/RBAC locks remain held.
  options?:{isolationLevel:'repeatable read'},
):Promise<T>{
  const denied=()=>new Error('Verified administrator MFA permission required');
  // Match the opaque user bearer format; never trust x-admin-role/user-id.
  if(typeof rawBearer!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(rawBearer)||
    !adminPermissions.includes(permission)){
    throw denied();
  }
  const digest=createHash('sha256').update(rawBearer,'ascii').digest('hex');
  return db.transaction(async tx=>{
    const [hint]=await tx.select({
      id:schema.userSessions.id,userId:schema.userSessions.userId,
    }).from(schema.userSessions)
      .where(eq(schema.userSessions.tokenDigest,digest)).limit(1);
    if(!hint)throw denied();
    // Account BEFORE session, matching device revoke lock order. A disabled
    // account or concurrently revoked device cannot race an authorized write.
    const [account]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,hint.userId)).limit(1).for('share');
    if(!account||account.status!=='active'||!account.emailVerifiedAt)throw denied();
    const [session]=await tx.select().from(schema.userSessions)
      .where(eq(schema.userSessions.id,hint.id)).limit(1).for('share');
    const now=Date.now();
    if(!session||session.userId!==account.id||session.tokenDigest!==digest||
      session.revokedAt||session.expiresAt.getTime()<=now){
      throw denied();
    }
    const [proof]=await tx.select().from(schema.adminSessionMfa)
      .where(eq(schema.adminSessionMfa.sessionId,session.id))
      .limit(1).for('share');
    if(!proof||proof.userId!==account.id||
      proof.verifiedAt.getTime()<session.createdAt.getTime()||
      proof.verifiedAt.getTime()>now||proof.expiresAt.getTime()<=now||
      proof.expiresAt.getTime()>proof.verifiedAt.getTime()+12*60*60*1000){
      throw denied();
    }
    const memberships=await tx.select({role:schema.adminRoleMemberships.role})
      .from(schema.adminRoleMemberships)
      .where(and(eq(schema.adminRoleMemberships.userId,account.id),
        isNull(schema.adminRoleMemberships.revokedAt)))
      .for('share');
    if(!hasAdminPermission(memberships.map(x=>x.role),permission)){
      throw denied();
    }
    // The operation is committed or rolled back together with the
    // authorization locks. Callers must audit privileged mutations here.
    return action(tx,{userId:account.id,sessionId:session.id});
  },options);
}
