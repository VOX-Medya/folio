import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {
  createFolioDb,registerPendingAccount,verifyAccountEmail,signInVerifiedAccount,
  revokeUserSession,withVerifiedAdminPermission,schema,
} from '../src/index.js';
import type {AdminPermission} from '@folio/contracts';

function check(value:unknown,message:string):asserts value{
  if(!value)throw new Error(message);
}
async function denied(work:()=>Promise<unknown>,message:string):Promise<void>{
  let rejected=false;
  try{await work();}catch{rejected=true;}
  if(!rejected)throw new Error(message);
}
async function main():Promise<void>{
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit isolated Folio DB required');
  const target=new URL(url);
  if(target.pathname!=='/folio_test'||
    !['127.0.0.1','localhost'].includes(target.hostname)||
    target.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Admin RBAC smoke must use isolated Folio loopback folio_test');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const password='Synthetic-Admin-Lab-Password-2026!';
  const email='admin-lab-'+randomUUID()+'@example.com';
  let callbacks=0;
  try{
    const registered=await registerPendingAccount(first.db,email,password);
    await verifyAccountEmail(second.db,registered.verificationToken);
    const ordinary=await signInVerifiedAccount(first.db,email,password,'admin-lab-web');
    const other=await registerPendingAccount(second.db,
      'non-admin-lab-'+randomUUID()+'@example.com',password);
    await verifyAccountEmail(first.db,other.verificationToken);
    const otherSession=await signInVerifiedAccount(second.db,
      'nonexistent-placeholder@example.com',password,'invalid').then(
        ()=>{throw new Error('Unexpected unrelated credential login');},
        ()=>null,
      );
    check(otherSession===null,'Synthetic unrelated account bypassed login');

    // Password+email verified bearer, even a supposedly privileged label,
    // cannot ever mint an administrator principal without BOTH DB factors.
    const tryPermission=(rawBearer:string,permission:AdminPermission)=>
      withVerifiedAdminPermission(first.db,rawBearer,permission,async(_tx,principal)=>{
        callbacks++;
        return principal;
      });
    await denied(()=>tryPermission(ordinary.sessionToken,'rights:review'),
      'Password-only session acquired admin permission');
    check(callbacks===0,'Denied authorization executed privileged callback');
    await first.db.insert(schema.adminRoleMemberships).values({
      userId:registered.userId,role:'rights',grantedBy:other.userId,
    });
    await denied(()=>tryPermission(ordinary.sessionToken,'rights:review'),
      'Persisted role alone bypassed mandatory MFA');

    // A synthetically injected MFA proof (ONLY in folio_test) cannot be
    // borrowed from another account or inferred from a signed-in cookie.
    const verifiedAt=new Date(),expiresAt=new Date(verifiedAt.getTime()+5*60_000);
    await first.db.insert(schema.adminSessionMfa).values({
      sessionId:ordinary.sessionId,userId:other.userId,method:'totp',
      verifiedAt,expiresAt,
    });
    await denied(()=>tryPermission(ordinary.sessionToken,'rights:review'),
      'Another user MFA record authorized current device');
    await first.db.update(schema.adminSessionMfa).set({userId:registered.userId})
      .where(eq(schema.adminSessionMfa.sessionId,ordinary.sessionId));

    const identity=await tryPermission(ordinary.sessionToken,'rights:review');
    check(identity.userId===registered.userId&&identity.sessionId===ordinary.sessionId,
      'Admin gate did not bind verified role to exact device');
    check(!('adminRoles' in identity),'Admin gate leaked mutable role claims');
    await denied(()=>tryPermission(ordinary.sessionToken,'catalog:edit'),
      'Rights reviewer obtained catalog editor rights');
    await denied(()=>tryPermission(ordinary.sessionToken,'personal:book:read'),
      'Rights reviewer accessed personal book body');
    await denied(()=>tryPermission('A'.repeat(43),'rights:review'),
      'Unknown but well-formed bearer acquired admin permission');
    await denied(()=>tryPermission('x-admin-role-superadmin','rights:review'),
      'Spoofed role header acquired admin permission');

    // Future-dated or already expired proof cannot bypass current checks.
    const future=new Date(Date.now()+60_000);
    await first.db.update(schema.adminSessionMfa).set({
      verifiedAt:future,expiresAt:new Date(future.getTime()+5*60_000),
    }).where(eq(schema.adminSessionMfa.sessionId,ordinary.sessionId));
    await denied(()=>tryPermission(ordinary.sessionToken,'rights:review'),
      'Future-dated fabricated MFA proof was accepted');
    const [sessionRow]=await first.db.select().from(schema.userSessions)
      .where(eq(schema.userSessions.id,ordinary.sessionId)).limit(1);
    check(sessionRow,'Missing synthetic device session');
    await first.db.update(schema.adminSessionMfa).set({
      verifiedAt:sessionRow.createdAt,
      expiresAt:new Date(sessionRow.createdAt.getTime()+1),
    }).where(eq(schema.adminSessionMfa.sessionId,ordinary.sessionId));
    await denied(()=>tryPermission(ordinary.sessionToken,'rights:review'),
      'Expired MFA was accepted');
    const renewed=new Date();
    await first.db.update(schema.adminSessionMfa).set({
      verifiedAt:renewed,expiresAt:new Date(renewed.getTime()+5*60_000),
    }).where(eq(schema.adminSessionMfa.sessionId,ordinary.sessionId));
    await denied(()=>first.db.update(schema.adminSessionMfa).set({
      expiresAt:new Date(renewed.getTime()+13*60*60_000),
    }).where(eq(schema.adminSessionMfa.sessionId,ordinary.sessionId)),
      'DB allowed excessive 13-hour MFA privilege proof');
    await denied(()=>first.db.update(schema.adminSessionMfa).set({
      method:'password',
    }).where(eq(schema.adminSessionMfa.sessionId,ordinary.sessionId)),
      'DB accepted a password-only MFA proof method');
    await denied(()=>first.db.insert(schema.adminRoleMemberships).values({
      userId:registered.userId,role:'root',grantedBy:other.userId,
    }), 'DB accepted role not in shared V1 allowlist');

    // Authorized writes and audit events must live inside the verification
    // transaction. A failed callback must roll back its audit completely.
    const auditAction='admin.lab.only.'+randomUUID();
    const requestId=randomUUID();
    await denied(()=>withVerifiedAdminPermission(
      first.db,ordinary.sessionToken,'rights:review',async(tx,who)=>{
        await tx.insert(schema.auditEvents).values({
          actorId:who.userId,action:auditAction,entityType:'user_session',
          entityId:who.sessionId,requestId,
        });
        throw new Error('Synthetic admin command abort');
      }),
      'Failed admin operation unexpectedly committed');
    let auditRows=await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.action,auditAction));
    check(auditRows.length===0,'Failed admin callback committed partial audit');
    await withVerifiedAdminPermission(
      first.db,ordinary.sessionToken,'rights:review',async(tx,who)=>{
        await tx.insert(schema.auditEvents).values({
          actorId:who.userId,action:auditAction,entityType:'user_session',
          entityId:who.sessionId,requestId,
        });
        return true;
      });
    auditRows=await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.action,auditAction));
    check(auditRows.length===1&&auditRows[0]?.requestId===requestId,
      'Authorized command and audit did not commit atomically');

    // Role revocation denies, regardless of the unexpired MFA session.
    await second.db.update(schema.adminRoleMemberships)
      .set({revokedAt:new Date()})
      .where(and(eq(schema.adminRoleMemberships.userId,registered.userId),
        eq(schema.adminRoleMemberships.role,'rights')));
    await denied(()=>tryPermission(ordinary.sessionToken,'rights:review'),
      'Revoked role continued to authorize a verified MFA session');

    // Even a superadmin can never read private book bodies.
    await first.db.insert(schema.adminRoleMemberships).values({
      userId:registered.userId,role:'superadmin',grantedBy:other.userId,
    });
    await tryPermission(ordinary.sessionToken,'admin:view');
    await denied(()=>tryPermission(ordinary.sessionToken,'personal:book:read'),
      'Superadmin read private user book bodies');

    // Server-side account changes and revocations terminate MFA privileges.
    await first.db.update(schema.userAccounts).set({status:'disabled'})
      .where(eq(schema.userAccounts.id,registered.userId));
    await denied(()=>tryPermission(ordinary.sessionToken,'admin:view'),
      'Disabled account retained privileged access');
    await first.db.update(schema.userAccounts).set({status:'active'})
      .where(eq(schema.userAccounts.id,registered.userId));
    check((await revokeUserSession(second.db,ordinary.sessionToken)).revoked,
      'Synthetic device could not be revoked');
    await denied(()=>tryPermission(ordinary.sessionToken,'admin:view'),
      'Revoked device remained administrator');
    const evidence=JSON.stringify(await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorId,registered.userId)));
    check(!evidence.includes(ordinary.sessionToken)&&!evidence.includes(password)&&
      !evidence.includes(email),'Admin audit disclosed credentials');

    console.log('ADMIN MFA RBAC PASS: no roles by default, role+per-device MFA mandatory, cross-account/future/expired proof deny, known grants and private-book deny, atomic callback rollback/audit, role/owner/device revoke, PostgreSQL constraints; test-only proof. No public admin route.');
  }finally{
    await first.pool.end();await second.pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
