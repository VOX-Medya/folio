import {and,eq,inArray,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import * as schema from './schema.js';

type AdminDb=ReturnType<typeof createFolioDb>['db'];
type AdminTx=Parameters<Parameters<AdminDb['transaction']>[0]>[0];
type RecoveryRow=typeof schema.adminMfaRecoveryRequests.$inferSelect;
export type AdminMfaRecoveryReview={
  id:string;
  targetUserId:string;
  status:'pending'|'approved'|'cancelled'|'expired';
  changed:boolean;
  expiresAt:string;
};

export const ADMIN_MFA_REVIEW_EXPIRY_MS=24*60*60*1000;
const referenceSchema=z.string().trim()
  .regex(/^REC-[A-Z0-9-]{8,60}$/,'Support reference must be a synthetic-safe REC identifier');
const reasonSchema=z.string().trim().min(24).max(1200);
const idSchema=z.uuid();
const active=['pending','approved'] as const;
function rejection(){return new Error('Verified two-operator MFA recovery review required');}
function result(row:RecoveryRow,changed:boolean):AdminMfaRecoveryReview{
  if(!['pending','approved','cancelled','expired'].includes(row.status)){
    throw rejection();
  }
  return {
    id:row.id,targetUserId:row.targetUserId,
    status:row.status as AdminMfaRecoveryReview['status'],
    changed,expiresAt:row.expiresAt.toISOString(),
  };
}
async function ensureTargetFactor(tx:AdminTx,target:string):Promise<void>{
  const [account]=await tx.select().from(schema.userAccounts)
    .where(eq(schema.userAccounts.id,target)).limit(1).for('share');
  if(!account||account.status!=='active'||!account.emailVerifiedAt){
    throw rejection();
  }
  const [membership]=await tx.select().from(schema.adminRoleMemberships)
    .where(and(eq(schema.adminRoleMemberships.userId,target),
      isNull(schema.adminRoleMemberships.revokedAt)))
    .limit(1).for('share');
  if(!membership)throw rejection();
  const [factor]=await tx.select({
    status:schema.adminTotpCredentials.status,
  }).from(schema.adminTotpCredentials)
    .where(eq(schema.adminTotpCredentials.userId,target)).limit(1).for('share');
  if(factor?.status!=='active')throw rejection();
}
async function expireIfElapsed(
  tx:AdminTx,row:RecoveryRow,now:Date,actor:string,requestId:string,
):Promise<RecoveryRow>{
  if(!active.includes(row.status as typeof active[number])||
    row.expiresAt.getTime()>now.getTime())return row;
  const [expired]=await tx.update(schema.adminMfaRecoveryRequests)
    .set({status:'expired',closedAt:now})
    .where(eq(schema.adminMfaRecoveryRequests.id,row.id)).returning();
  if(!expired)throw rejection();
  await tx.insert(schema.auditEvents).values({
    actorId:actor,action:'admin.mfa.recovery.review.expired',
    entityType:'admin_mfa_recovery_request',entityId:row.id,
    requestId,afterJson:{status:'expired',targetUserId:row.targetUserId},
    beforeJson:{status:row.status},
  });
  return expired;
}

/**
 * This is a two-person REVIEW request, NOT a recovery or reset mechanism.
 * Only an existing MFA-verified superadmin can propose a review. No
 * credential, OTP, session, role, or recovery token changes or gets emitted.
 * A human-backed ticket/reference must later be reviewed out of band.
 */
export async function proposeAdminMfaRecoveryReview(
  db:AdminDb,bearer:string,rawTarget:string,rawReference:string,
  rawReason:string,rawRequestId:string,
):Promise<AdminMfaRecoveryReview>{
  const target=idSchema.parse(rawTarget);
  const ticket=referenceSchema.parse(rawReference);
  const why=reasonSchema.parse(rawReason);
  const trace=idSchema.parse(rawRequestId);
  return withVerifiedAdminPermission(db,bearer,'users:support',async(tx,actor)=>{
    if(actor.userId===target)throw rejection();
    // Acquire target account+membership+factor share locks BEFORE review row.
    // This is a proposal for a previously configured active admin factor,
    // not a backdoor for a role-less user or pending enrollment.
    await ensureTargetFactor(tx,target);
    const now=new Date();
    const [existing]=await tx.select().from(schema.adminMfaRecoveryRequests)
      .where(and(eq(schema.adminMfaRecoveryRequests.targetUserId,target),
        inArray(schema.adminMfaRecoveryRequests.status,[...active])))
      .limit(1).for('update');
    if(existing){
      const checked=await expireIfElapsed(tx,existing,now,actor.userId,trace);
      if(checked.status!=='expired'){
        if(checked.proposalReference!==ticket)throw rejection();
        return result(checked,false);
      }
    }
    // Unique partial index also handles simultaneous creators on separate
    // DB pools; the loser reads back the winner and creates NO fake audit.
    const [inserted]=await tx.insert(schema.adminMfaRecoveryRequests).values({
      targetUserId:target,proposedBy:actor.userId,
      proposalReference:ticket,reason:why,createdAt:now,
      expiresAt:new Date(now.getTime()+ADMIN_MFA_REVIEW_EXPIRY_MS),
    }).onConflictDoNothing().returning();
    if(!inserted){
      const [duplicate]=await tx.select().from(schema.adminMfaRecoveryRequests)
        .where(and(eq(schema.adminMfaRecoveryRequests.targetUserId,target),
          inArray(schema.adminMfaRecoveryRequests.status,[...active])))
        .limit(1);
      if(!duplicate||duplicate.proposalReference!==ticket)throw rejection();
      return result(duplicate,false);
    }
    await tx.insert(schema.auditEvents).values({
      actorId:actor.userId,action:'admin.mfa.recovery.review.proposed',
      entityType:'admin_mfa_recovery_request',entityId:inserted.id,
      requestId:trace,reason:why,
      afterJson:{targetUserId:target,reference:ticket,status:'pending',
        expiresAt:inserted.expiresAt.toISOString()},
    });
    return result(inserted,true);
  });
}

/**
 * A DIFFERENT MFA-verified superadmin may mark a request approved for
 * offline human identity review. Approval NEVER clears or replaces a seed.
 * The same row FOR UPDATE guarantees one approver and one audit under races.
 */
export async function approveAdminMfaRecoveryReview(
  db:AdminDb,bearer:string,rawReviewId:string,rawReference:string,
  rawReason:string,rawRequestId:string,
):Promise<AdminMfaRecoveryReview>{
  const reviewId=idSchema.parse(rawReviewId);
  const ticket=referenceSchema.parse(rawReference);
  const why=reasonSchema.parse(rawReason);
  const trace=idSchema.parse(rawRequestId);
  return withVerifiedAdminPermission(db,bearer,'users:support',async(tx,actor)=>{
    const [row]=await tx.select().from(schema.adminMfaRecoveryRequests)
      .where(eq(schema.adminMfaRecoveryRequests.id,reviewId))
      .limit(1).for('update');
    if(!row||row.proposalReference!==ticket||
      actor.userId===row.proposedBy||actor.userId===row.targetUserId){
      throw rejection();
    }
    const now=new Date();
    if(row.status==='approved')return result(row,false);
    if(row.status==='cancelled'||row.status==='expired')throw rejection();
    const checked=await expireIfElapsed(tx,row,now,actor.userId,trace);
    if(checked.status==='expired')return result(checked,true);
    // An account may be disabled or its role/factor removed in between the
    // two operators: never approve a stale privilege/recovery subject.
    await ensureTargetFactor(tx,row.targetUserId);
    const [approved]=await tx.update(schema.adminMfaRecoveryRequests)
      .set({status:'approved',approvedBy:actor.userId,approvedAt:now})
      .where(eq(schema.adminMfaRecoveryRequests.id,row.id)).returning();
    if(!approved)throw rejection();
    await tx.insert(schema.auditEvents).values({
      actorId:actor.userId,action:'admin.mfa.recovery.review.approved',
      entityType:'admin_mfa_recovery_request',entityId:row.id,
      requestId:trace,reason:why,
      beforeJson:{status:'pending'},
      afterJson:{status:'approved',targetUserId:row.targetUserId,
        approvedBy:actor.userId,reference:ticket},
    });
    return result(approved,true);
  });
}

/** Any current MFA-superadmin can cancel a pending/approved review. Closed
 * requests cannot be resurrected; repeat cancellation creates no fake audit.
 * The TOTP factor and all previously issued MFA proofs remain untouched. */
export async function cancelAdminMfaRecoveryReview(
  db:AdminDb,bearer:string,rawReviewId:string,rawReason:string,
  rawRequestId:string,
):Promise<AdminMfaRecoveryReview>{
  const reviewId=idSchema.parse(rawReviewId);
  const why=reasonSchema.parse(rawReason);
  const trace=idSchema.parse(rawRequestId);
  return withVerifiedAdminPermission(db,bearer,'users:support',async(tx,actor)=>{
    const [row]=await tx.select().from(schema.adminMfaRecoveryRequests)
      .where(eq(schema.adminMfaRecoveryRequests.id,reviewId))
      .limit(1).for('update');
    if(!row)throw rejection();
    if(row.status==='cancelled'||row.status==='expired')return result(row,false);
    const now=new Date();
    const checked=await expireIfElapsed(tx,row,now,actor.userId,trace);
    if(checked.status==='expired')return result(checked,true);
    const [cancelled]=await tx.update(schema.adminMfaRecoveryRequests)
      .set({status:'cancelled',closedAt:now})
      .where(eq(schema.adminMfaRecoveryRequests.id,row.id)).returning();
    if(!cancelled)throw rejection();
    await tx.insert(schema.auditEvents).values({
      actorId:actor.userId,action:'admin.mfa.recovery.review.cancelled',
      entityType:'admin_mfa_recovery_request',entityId:row.id,
      requestId:trace,reason:why,
      beforeJson:{status:row.status},
      afterJson:{status:'cancelled',targetUserId:row.targetUserId},
    });
    return result(cancelled,true);
  });
}
