import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {
  createFolioDb,registerPendingAccount,verifyAccountEmail,signInVerifiedAccount,
  withVerifiedAdminPermission,grantManagedAdminRole,revokeManagedAdminRole,
  revokeUserSession,schema,
} from '../src/index.js';

function check(value:unknown,message:string):asserts value{
  if(!value)throw new Error(message);
}
async function blocked(work:()=>Promise<unknown>,message:string){
  let denied=false;
  try{await work();}catch{denied=true;}
  if(!denied)throw new Error(message);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio test database required');
  const targetUrl=new URL(url);
  if(targetUrl.pathname!=='/folio_test'||
    !['127.0.0.1','localhost'].includes(targetUrl.hostname)||
    targetUrl.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Admin lifecycle integration requires Folio loopback folio_test');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const password='Synthetic-Role-Manager-Password-2026!';
  const trace=()=>randomUUID();
  try{
    const managerEmail='synthetic-role-admin-'+trace()+'@example.com';
    const manager=await registerPendingAccount(first.db,managerEmail,password);
    await verifyAccountEmail(second.db,manager.verificationToken);
    const managerWeb=await signInVerifiedAccount(first.db,managerEmail,password,'manager-web');
    const managerTablet=await signInVerifiedAccount(second.db,managerEmail,password,'manager-tablet');
    const userEmail='synthetic-role-target-'+trace()+'@example.com';
    const member=await registerPendingAccount(second.db,userEmail,password);
    await verifyAccountEmail(first.db,member.verificationToken);
    const memberSession=await signInVerifiedAccount(first.db,userEmail,password,'member-web');
    const pending=await registerPendingAccount(first.db,
      'synthetic-role-pending-'+trace()+'@example.com',password);
    const validReason='Approved synthetic lab role membership for RBAC testing only.';
    const requestId=trace();
    // A normal session cannot grant roles, even when the attacker selects a
    // real verified target and claims the right role or request UUID.
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights',validReason,requestId),
      'Password login was sufficient to grant a role');

    // Isolated lab ONLY: seed a baseline superadmin + two synthetic proofs
    // to simulate post-MFA state. No real app code can create these.
    await first.db.insert(schema.adminRoleMemberships).values({
      userId:manager.userId,role:'superadmin',grantedBy:manager.userId,
    });
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights',validReason,requestId),
      'Persisted superadmin without MFA granted another account');
    for(const session of [managerWeb,managerTablet]){
      const now=new Date();
      await first.db.insert(schema.adminSessionMfa).values({
        sessionId:session.sessionId,userId:manager.userId,method:'totp',
        verifiedAt:now,expiresAt:new Date(now.getTime()+5*60_000),
      });
    }
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'superadmin',validReason,requestId),
      'Web admin silently created a superadmin');
    await blocked(()=>revokeManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'superadmin',validReason,requestId),
      'Web admin could revoke the protected superadmin role');
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      manager.userId,'editor',validReason,requestId),
      'Administrator self-granted editor role');
    await blocked(()=>revokeManagedAdminRole(first.db,managerWeb.sessionToken,
      manager.userId,'editor',validReason,requestId),
      'Administrator self-revoked roles');
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'root',validReason,requestId),
      'Unknown role accepted');
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights',validReason,'client-chosen-trace'),
      'Malformed request ID entered role grant');
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights','no',requestId),
      'Unsigned or unexplained role change accepted');
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      pending.userId,'rights',validReason,requestId),
      'Unverified e-mail received admin role');
    await blocked(()=>grantManagedAdminRole(first.db,memberSession.sessionToken,
      manager.userId,'rights',validReason,requestId),
      'Non-admin session with valid token assigned roles');

    const granted=await grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights',validReason,requestId);
    check(granted.changed&&granted.userId===member.userId&&granted.role==='rights',
      'Validated privileged role assignment missing');
    const duplicate=await grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights',validReason,trace());
    check(!duplicate.changed,'Repeat grant created a second membership');

    // Without the target's OWN per-device factor even a granted role is inert.
    await blocked(()=>withVerifiedAdminPermission(first.db,memberSession.sessionToken,
      'rights:review',async()=>true),'Role grant bypassed target MFA');
    const memberProof=new Date();
    await first.db.insert(schema.adminSessionMfa).values({
      sessionId:memberSession.sessionId,userId:member.userId,method:'totp',
      verifiedAt:memberProof,expiresAt:new Date(memberProof.getTime()+5*60_000),
    });
    check(await withVerifiedAdminPermission(first.db,memberSession.sessionToken,
      'rights:review',async()=>true),'New MFA rights reviewer cannot review');
    await blocked(()=>withVerifiedAdminPermission(first.db,memberSession.sessionToken,
      'users:support',async()=>true),
      'Rights reviewer was escalated to admin role management');

    // Two distinct pools / authenticated manager devices race the same target.
    // Unique membership + ON CONFLICT must create ONE audit + ONE grant only.
    const raced=await Promise.all([
      grantManagedAdminRole(first.db,managerWeb.sessionToken,
        member.userId,'audio',validReason,trace()),
      grantManagedAdminRole(second.db,managerTablet.sessionToken,
        member.userId,'audio',validReason,trace()),
    ]);
    check(raced.filter(x=>x.changed).length===1,
      'Concurrent role grants produced more than one new role');
    const [audioGrant]=await first.db.select().from(schema.adminRoleMemberships)
      .where(and(eq(schema.adminRoleMemberships.userId,member.userId),
        eq(schema.adminRoleMemberships.role,'audio')));
    check(audioGrant?.grantedBy===manager.userId&&audioGrant.revokedAt===null,
      'Role mutation was not linked to verified server-side actor');

    const revokeId=trace();
    const revoked=await revokeManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights',validReason,revokeId);
    check(revoked.changed,'Rights role revocation failed');
    await blocked(()=>withVerifiedAdminPermission(first.db,memberSession.sessionToken,
      'rights:review',async()=>true),
      'Revoked rights role retained permission through an existing MFA proof');
    const repeated=await revokeManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights',validReason,trace());
    check(!repeated.changed,'Repeated revoke was not idempotent');
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'rights',validReason,trace()),
      'Revoked role was silently reactivated');

    const revokeRace=await Promise.all([
      revokeManagedAdminRole(first.db,managerWeb.sessionToken,
        member.userId,'audio',validReason,trace()),
      revokeManagedAdminRole(second.db,managerTablet.sessionToken,
        member.userId,'audio',validReason,trace()),
    ]);
    check(revokeRace.filter(x=>x.changed).length===1,
      'Concurrent role revocations performed twice');

    const audit=await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId,member.userId));
    const newGrants=audit.filter(x=>x.action==='admin.role.grant');
    const newRevokes=audit.filter(x=>x.action==='admin.role.revoke');
    check(newGrants.length===2&&newRevokes.length===2,
      'Failed/duplicate role actions produced unexpected audit rows');
    check(newGrants.some(x=>x.requestId===requestId&&x.actorId===manager.userId&&
      x.reason===validReason),'Grant event missing actor, reason or trusted request ID');
    check(newRevokes.some(x=>x.requestId===revokeId&&x.actorId===manager.userId),
      'Revocation event missing trusted request ID or actor');
    const allAudit=JSON.stringify(audit);
    for(const forbidden of [password,managerEmail,userEmail,
      managerWeb.sessionToken,managerTablet.sessionToken,memberSession.sessionToken]){
      check(!allAudit.includes(forbidden),'Role audit leaked a secret or raw credential');
    }

    // Revocation of the manager session instantly ends future role operations.
    check((await revokeUserSession(second.db,managerWeb.sessionToken)).revoked,
      'Manager device could not be revoked');
    await blocked(()=>grantManagedAdminRole(first.db,managerWeb.sessionToken,
      member.userId,'editor',validReason,trace()),
      'Revoked superadmin device still assigned roles');
    console.log('ADMIN ROLE LIFECYCLE PASS: MFA superadmin only, no self/superadmin grants, active target, auditable request-id/reason, immutable revocation, two-pool idempotent grant/revoke, target MFA, revoked device and secret-free audit. Test-only factors; no HTTP admin route.');
  }finally{
    await first.pool.end();await second.pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
