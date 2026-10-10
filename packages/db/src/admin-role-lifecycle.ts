import {and,eq,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import {adminRoles} from '@folio/contracts';
import type {AdminRole} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import * as schema from './schema.js';

type AdminDb=ReturnType<typeof createFolioDb>['db'];
export type AdminRoleChange={changed:boolean;userId:string;role:Exclude<AdminRole,'superadmin'>};

function requireRole(raw:string):Exclude<AdminRole,'superadmin'>{
  if(!adminRoles.includes(raw as AdminRole)||raw==='superadmin'){
    throw new Error('This administrative role cannot be assigned or revoked');
  }
  return raw as Exclude<AdminRole,'superadmin'>;
}
function requireTraceAndReason(requestId:string,reason:string){
  return {
    requestId:z.uuid().parse(requestId),
    reason:z.string().trim().min(12).max(1200).parse(reason),
  };
}

/**
 * Future privileged admin HTTP/CLI must supply the real server-generated
 * request ID and the raw verified session token via a safe transport.
 * No live admin controller, first-superadmin grant, or MFA issuer exists.
 *
 * This path can ONLY be called by a DB-recognized superadmin with a current
 * device-bound MFA proof. A normal auth session or spoofed admin header fails.
 */
export async function grantManagedAdminRole(
  db:AdminDb,adminSessionBearer:string,rawUserId:string,rawRole:string,
  reason:string,requestId:string,
):Promise<AdminRoleChange>{
  const target=z.uuid().parse(rawUserId);
  const role=requireRole(rawRole);
  const verified=requireTraceAndReason(requestId,reason);
  return withVerifiedAdminPermission(db,adminSessionBearer,'users:support',
    async(tx,actor)=>{
      if(actor.userId===target){
        throw new Error('Administrator cannot change own roles');
      }
      // FOR SHARE blocks account disabling without deadlocking two concurrent
      // role managers. Unique PK and on-conflict handling serialize same role.
      const [account]=await tx.select({
        id:schema.userAccounts.id,
        status:schema.userAccounts.status,
        emailVerifiedAt:schema.userAccounts.emailVerifiedAt,
      }).from(schema.userAccounts)
        .where(eq(schema.userAccounts.id,target)).limit(1).for('share');
      if(!account||account.status!=='active'||!account.emailVerifiedAt){
        throw new Error('Verified active target account required');
      }
      const [added]=await tx.insert(schema.adminRoleMemberships).values({
        userId:target,role,grantedBy:actor.userId,
      }).onConflictDoNothing().returning({userId:schema.adminRoleMemberships.userId});
      if(!added){
        const [existing]=await tx.select({revokedAt:schema.adminRoleMemberships.revokedAt})
          .from(schema.adminRoleMemberships).where(and(
            eq(schema.adminRoleMemberships.userId,target),
            eq(schema.adminRoleMemberships.role,role),
          )).limit(1);
        if(existing?.revokedAt){
          // An already revoked membership needs explicit later policy review;
          // silently clearing its revocation is forbidden.
          throw new Error('Revoked admin role cannot be silently reactivated');
        }
        return {changed:false,userId:target,role};
      }
      await tx.insert(schema.auditEvents).values({
        actorId:actor.userId,action:'admin.role.grant',
        entityType:'user_account',entityId:target,
        requestId:verified.requestId,reason:verified.reason,
        beforeJson:{role,active:false},
        afterJson:{role,active:true},
      });
      return {changed:true,userId:target,role};
    });
}

/** Revocations are monotonic; repeated requests do not create fake audits. */
export async function revokeManagedAdminRole(
  db:AdminDb,adminSessionBearer:string,rawUserId:string,rawRole:string,
  reason:string,requestId:string,
):Promise<AdminRoleChange>{
  const target=z.uuid().parse(rawUserId);
  const role=requireRole(rawRole);
  const verified=requireTraceAndReason(requestId,reason);
  return withVerifiedAdminPermission(db,adminSessionBearer,'users:support',
    async(tx,actor)=>{
      if(actor.userId===target){
        throw new Error('Administrator cannot change own roles');
      }
      const [existing]=await tx.select().from(schema.adminRoleMemberships)
        .where(and(eq(schema.adminRoleMemberships.userId,target),
          eq(schema.adminRoleMemberships.role,role)))
        .limit(1).for('update');
      if(!existing||existing.revokedAt)return {changed:false,userId:target,role};
      await tx.update(schema.adminRoleMemberships)
        .set({revokedAt:sql`now()`})
        .where(and(eq(schema.adminRoleMemberships.userId,target),
          eq(schema.adminRoleMemberships.role,role),
          isNull(schema.adminRoleMemberships.revokedAt)));
      await tx.insert(schema.auditEvents).values({
        actorId:actor.userId,action:'admin.role.revoke',
        entityType:'user_account',entityId:target,
        requestId:verified.requestId,reason:verified.reason,
        beforeJson:{role,active:true},afterJson:{role,active:false},
      });
      return {changed:true,userId:target,role};
    });
}
