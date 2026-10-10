import {randomBytes,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {
  beginAdminTotpEnrollment,confirmAdminTotpEnrollment,createFolioDb,
  inspectAdminTotpKeyVersions,registerPendingAccount,
  rotateAdminTotpEnvelopeForUser,signInVerifiedAccount,verifyAccountEmail,
  verifyAdminTotpForSession,withVerifiedAdminPermission,schema,
} from '../src/index.js';
import {
  decodeTotpBase32,decryptTotpSeed,totpCodeAtStep,
} from '../src/admin-totp-crypto.js';

function check(value:unknown,message:string):asserts value{
  if(!value)throw new Error(message);
}
async function blocked(work:()=>Promise<unknown>,message:string){
  let stopped=false;
  try{await work();}catch{stopped=true;}
  if(!stopped)throw new Error(message);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit isolated Folio DB required');
  const target=new URL(url);
  if(target.pathname!=='/folio_test'||
    !['localhost','127.0.0.1'].includes(target.hostname)||
    target.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('MFA key rotation smoke requires Folio loopback folio_test');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const v1=randomBytes(32).toString('hex');
  const v2=randomBytes(32).toString('hex');
  const badV1=randomBytes(32).toString('hex');
  const both={activeVersion:'v2' as const,v1,v2};
  const reason='Approved synthetic Folio TOTP encryption envelope rotation test.';
  const password='Synthetic-MFA-Rollover-Password-2026!';
  const trace=()=>randomUUID();
  try{
    async function account(label:string){
      const email=label+'-'+trace()+'@example.com';
      const registration=await registerPendingAccount(first.db,email,password);
      await verifyAccountEmail(second.db,registration.verificationToken);
      const session=await signInVerifiedAccount(first.db,email,password,label);
      return {...registration,session,email};
    }
    const manager=await account('synthetic-factor-operator');
    const a=await account('synthetic-rotate-active');
    const b=await account('synthetic-rotate-pending');
    const c=await account('synthetic-new-v2');

    // Only test fixtures may bootstrap this superadmin/MFA proof. There is no
    // production first-superadmin or key rotation HTTP endpoint.
    await first.db.insert(schema.adminRoleMemberships).values({
      userId:manager.userId,role:'superadmin',grantedBy:manager.userId,
    });
    const tablet=await signInVerifiedAccount(second.db,manager.email,
      password,'superadmin-tablet');
    for(const member of [a,b,c]){
      await first.db.insert(schema.adminRoleMemberships).values({
        userId:member.userId,role:'rights',grantedBy:manager.userId,
      });
    }
    await blocked(()=>inspectAdminTotpKeyVersions(first.db,manager.session.sessionToken),
      'Superadmin password without MFA saw encryption version inventory');
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      manager.session.sessionToken,a.userId,'v1','v2',both,reason,trace()),
      'Superadmin password without MFA rotated a secret');
    for(const session of [manager.session,tablet]){
      const now=new Date();
      await first.db.insert(schema.adminSessionMfa).values({
        sessionId:session.sessionId,userId:manager.userId,method:'totp',
        verifiedAt:now,expiresAt:new Date(now.getTime()+5*60_000),
      });
    }
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      a.session.sessionToken,a.userId,'v1','v2',both,reason,trace()),
      'Unprivileged account with password-only session rotated own seed');
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      manager.session.sessionToken,trace(),'v1','v2',both,reason,trace()),
      'Factor absent in DB was accepted by rotation');

    const startA=await beginAdminTotpEnrollment(
      first.db,a.session.sessionToken,v1,trace());
    const seedA=decodeTotpBase32(startA.secretBase32);
    const confirmStepA=Math.floor(Date.now()/30_000);
    await confirmAdminTotpEnrollment(first.db,a.session.sessionToken,
      totpCodeAtStep(seedA,confirmStepA),v1,trace());
    const [activeBefore]=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,a.userId));
    check(activeBefore?.status==='active'&&
      activeBefore.keyVersion==='v1'&&
      activeBefore.lastAcceptedStep===confirmStepA,
      'Baseline legacy v1 factor confirmation failed');

    const startB=await beginAdminTotpEnrollment(
      first.db,b.session.sessionToken,v1,trace());
    const seedB=decodeTotpBase32(startB.secretBase32);
    const [pendingBefore]=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,b.userId));
    check(pendingBefore?.status==='pending'&&
      pendingBefore.keyVersion==='v1','Baseline legacy pending factor missing');
    const inventoryBefore=await inspectAdminTotpKeyVersions(
      first.db,manager.session.sessionToken);
    check(inventoryBefore.v1>=2,'Active and pending legacy factors uncounted');

    const malformed=trace();
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      manager.session.sessionToken,malformed,'v1','v1',both,reason,trace()),
      'Same-version rewrap was accepted');
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      manager.session.sessionToken,a.userId,'v1','v2',both,
      'too short',trace()),'Missing operator reason was accepted');
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      manager.session.sessionToken,a.userId,'v1','v2',both,
      reason,'client-forged-request-id'),'Malformed request UUID was accepted');
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      manager.session.sessionToken,a.userId,'v1','v2',
      {activeVersion:'v2',v1:badV1,v2},reason,trace()),
      'Incorrect old key rewrapped authenticated factor');
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      manager.session.sessionToken,a.userId,'v1','v2',
      {activeVersion:'v2',v2},reason,trace()),
      'Missing old key erased legacy factor');
    await blocked(()=>rotateAdminTotpEnvelopeForUser(first.db,
      manager.session.sessionToken,a.userId,'v1','v2',
      {activeVersion:'v2',v1,v2:v1},reason,trace()),
      'Same key configured in both versions was accepted');
    const [untouched]=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,a.userId));
    check(untouched?.nonce===activeBefore.nonce&&
      untouched?.ciphertext===activeBefore.ciphertext&&
      untouched?.lastAcceptedStep===confirmStepA,
      'Failed key rotation changed verified factor bytes or replay counter');

    // Real concurrent two-pool / two-device operator race: one new GCM IV,
    // one actual audit, one idempotent replay with no fake change.
    const requestId=trace(),secondRequestId=trace();
    const raced=await Promise.all([
      rotateAdminTotpEnvelopeForUser(first.db,manager.session.sessionToken,
        a.userId,'v1','v2',both,reason,requestId),
      rotateAdminTotpEnvelopeForUser(second.db,tablet.sessionToken,
        a.userId,'v1','v2',both,reason,secondRequestId),
    ]);
    check(raced.filter(x=>x.changed).length===1&&
      raced.filter(x=>!x.changed).length===1,
      'Concurrent encrypted envelope rewrap duplicated changes');
    const [updatedA]=await second.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,a.userId));
    check(updatedA?.keyVersion==='v2'&&updatedA.nonce!==activeBefore.nonce&&
      updatedA.ciphertext!==activeBefore.ciphertext&&
      updatedA.status===activeBefore.status&&
      updatedA.lastAcceptedStep===activeBefore.lastAcceptedStep&&
      updatedA.failedAttempts===activeBefore.failedAttempts&&
      updatedA.enabledAt?.getTime()===activeBefore.enabledAt?.getTime()&&
      updatedA.createdAt.getTime()===activeBefore.createdAt.getTime(),
      'Rewrap damaged activation state, replay fence or encryption IV');
    check(decryptTotpSeed(a.userId,updatedA,v2).equals(seedA),
      'Rewrap silently changed the authenticator seed');
    await blocked(async()=>decryptTotpSeed(a.userId,updatedA,v1),
      'Old v1 key still decrypted v2 account factor');
    await blocked(()=>verifyAdminTotpForSession(first.db,
      a.session.sessionToken,totpCodeAtStep(seedA,confirmStepA+1),
      {activeVersion:'v2',v2:badV1},trace()),
      'Wrong v2 key verified rewrapped factor');

    const firstUsableStep=Math.max(confirmStepA+1,Math.floor(Date.now()/30_000));
    check((await verifyAdminTotpForSession(first.db,a.session.sessionToken,
      totpCodeAtStep(seedA,firstUsableStep),both,trace())).verified,
      'Current TOTP app code could not verify after v1->v2 rewrap');
    check(await withVerifiedAdminPermission(first.db,a.session.sessionToken,
      'rights:review',async()=>true),
      'Envelope rewrap discarded role/MFA device eligibility');
    await blocked(()=>verifyAdminTotpForSession(first.db,
      a.session.sessionToken,totpCodeAtStep(seedA,firstUsableStep),both,trace()),
      'Rotation reset the accepted TOTP step allowing replay');

    // Pending factors survive envelope rollover, remain pending, and can be
    // confirmed with exactly the SAME old authenticator QR/secret.
    const rotatedPending=await rotateAdminTotpEnvelopeForUser(
      first.db,manager.session.sessionToken,b.userId,'v1','v2',both,reason,trace());
    check(rotatedPending.changed,'Pending envelope rotation failed');
    const [pendingAfter]=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,b.userId));
    check(pendingAfter?.status==='pending'&&
      pendingAfter.pendingExpiresAt?.getTime()===
        pendingBefore.pendingExpiresAt?.getTime()&&
      pendingAfter.lastAcceptedStep===pendingBefore.lastAcceptedStep,
      'Rewrap changed pending factor TTL or replay fence');
    await confirmAdminTotpEnrollment(first.db,b.session.sessionToken,
      totpCodeAtStep(seedB,Math.floor(Date.now()/30_000)),both,trace());

    // Opt-in v2 active enrollment uses a distinct key; old v1 credentials
    // can still be read during the staged rollout.
    const startC=await beginAdminTotpEnrollment(
      first.db,c.session.sessionToken,both,trace());
    const [newV2]=await first.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,c.userId));
    check(newV2?.keyVersion==='v2'&&
      !JSON.stringify(newV2).includes(startC.secretBase32),
      'New v2 active-key enrollment did not encrypt under v2');
    await confirmAdminTotpEnrollment(first.db,c.session.sessionToken,
      totpCodeAtStep(decodeTotpBase32(startC.secretBase32),
        Math.floor(Date.now()/30_000)),both,trace());

    const inventoryAfter=await inspectAdminTotpKeyVersions(
      first.db,manager.session.sessionToken);
    check(inventoryAfter.v1===inventoryBefore.v1-2&&
      inventoryAfter.v2===inventoryBefore.v2+3,
      'Privileged key-version inventory omitted pending/new rows');
    const audit=await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId,a.userId));
    const rewrapAudit=audit.filter(x=>x.action==='admin.totp.envelope.rotated');
    check(rewrapAudit.length===1&&
      rewrapAudit[0]?.actorId===manager.userId&&
      rewrapAudit[0]?.reason===reason&&
      [requestId,secondRequestId].includes(rewrapAudit[0]?.requestId??''),
      'Racing rotation did not create one attributable audit');
    const allAudit=JSON.stringify(await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorId,manager.userId)));
    for(const forbidden of [v1,v2,badV1,password,startA.secretBase32,
      startB.secretBase32,startC.secretBase32,manager.session.sessionToken]){
      check(!allAudit.includes(forbidden),
        'Encryption key, TOTP seed or bearer leaked to rotation audit');
    }
    console.log('ADMIN TOTP KEY ROTATION PASS: MFA-superadmin only, v1/v2 dual read, new v2 enrollment, pending+active rewrap, wrong key rollback, unchanged replay state, concurrent two-pool single audit, privileged retirement counts and no secret leaks. Isolated Folio test DB only.');
  }finally{await first.pool.end();await second.pool.end();}
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
