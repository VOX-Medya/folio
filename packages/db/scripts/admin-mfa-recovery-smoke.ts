import {randomUUID,randomBytes} from 'node:crypto';
import {and,eq,inArray} from 'drizzle-orm';
import {
  approveAdminMfaRecoveryReview,beginAdminTotpEnrollment,
  cancelAdminMfaRecoveryReview,confirmAdminTotpEnrollment,createFolioDb,
  proposeAdminMfaRecoveryReview,registerPendingAccount,
  signInVerifiedAccount,verifyAccountEmail,verifyAdminTotpForSession,
  withVerifiedAdminPermission,schema,
} from '../src/index.js';
import {decodeTotpBase32,totpCodeAtStep} from '../src/admin-totp-crypto.js';

function check(value:unknown,message:string):asserts value{
  if(!value)throw Error(message);
}
async function blocked(action:()=>Promise<unknown>,message:string){
  let denied=false;
  try{await action();}catch{denied=true;}
  if(!denied)throw Error(message);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw Error('Explicit isolated Folio DB required');
  const database=new URL(url);
  if(database.pathname!=='/folio_test'||
    !['localhost','127.0.0.1'].includes(database.hostname)||
    database.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw Error('MFA recovery review smoke restricted to Folio-only loopback folio_test');
  }
  const one=createFolioDb(url),two=createFolioDb(url);
  const password='Synthetic-MFA-Recovery-Review-2026-Strong!';
  const key=randomBytes(32).toString('hex');
  const uuid=()=>randomUUID();
  const proposeReason='Simulated lost authenticator report with independent human verification pending.';
  const approveReason='Simulated independent support reviewer checked the external case reference.';
  const cancelReason='Synthetic operator cancelled recovery review before any factor replacement.';
  const ticket='REC-SYNTH-'+uuid().replaceAll('-','').slice(0,18).toUpperCase();
  type Account={
    userId:string;
    token:string;
    sessionId:string;
    email:string;
  };
  try{
    async function account(label:string,role?:'superadmin'|'rights'):Promise<Account>{
      const email='synthetic-mfa-recovery-'+label+'-'+uuid()+'@example.com';
      const registered=await registerPendingAccount(one.db,email,password);
      await verifyAccountEmail(two.db,registered.verificationToken);
      if(role){
        await one.db.insert(schema.adminRoleMemberships).values({
          userId:registered.userId,role,grantedBy:registered.userId,
        }); // Synthetic test-only first-admin provisioning. NEVER production.
      }
      const session=await signInVerifiedAccount(one.db,email,password,label);
      return {
        userId:registered.userId,sessionId:session.sessionId,
        token:session.sessionToken,email,
      };
    }
    async function factor(user:Account,withProof:boolean):Promise<void>{
      const pending=await beginAdminTotpEnrollment(
        one.db,user.token,key,uuid());
      const seed=decodeTotpBase32(pending.secretBase32);
      const firstStep=Math.floor(Date.now()/30_000);
      await confirmAdminTotpEnrollment(one.db,user.token,
        totpCodeAtStep(seed,firstStep),key,uuid());
      if(withProof){
        const validStep=Math.max(firstStep+1,Math.floor(Date.now()/30_000));
        await verifyAdminTotpForSession(one.db,user.token,
          totpCodeAtStep(seed,validStep),key,uuid());
      }
      seed.fill(0);
    }
    const requester=await account('requester','superadmin');
    const reviewerA=await account('review-a','superadmin');
    const reviewerB=await account('review-b','superadmin');
    const lost=await account('lost-factor','rights');
    const withoutFactor=await account('not-enrolled','rights');
    const ordinary=await account('ordinary');

    await blocked(()=>proposeAdminMfaRecoveryReview(one.db,
      requester.token,lost.userId,ticket,proposeReason,uuid()),
      'Unverified first superadmin MFA opened recovery review');
    await blocked(()=>proposeAdminMfaRecoveryReview(one.db,
      ordinary.token,lost.userId,ticket,proposeReason,uuid()),
      'Ordinary bearer opened recovery review');

    await factor(requester,true);
    await factor(reviewerA,true);
    await factor(reviewerB,true);
    await factor(lost,false);
    await blocked(()=>withVerifiedAdminPermission(one.db,lost.token,
      'users:support',async()=>true),
      'Lost-factor target was allowed to perform superadmin work');

    const [beforeFactor]=await one.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,lost.userId));
    check(!!beforeFactor&&beforeFactor.status==='active',
      'Recovery candidate must have an actual enabled TOTP factor');
    const proofBefore=await one.db.select().from(schema.adminSessionMfa)
      .where(eq(schema.adminSessionMfa.userId,lost.userId));
    check(proofBefore.length===0,'Lost-device fixture unexpectedly has MFA proof');

    await blocked(()=>proposeAdminMfaRecoveryReview(one.db,
      requester.token,requester.userId,ticket,proposeReason,uuid()),
      'Superadmin proposed recovery for own factor');
    await blocked(()=>proposeAdminMfaRecoveryReview(one.db,
      requester.token,withoutFactor.userId,ticket,proposeReason,uuid()),
      'Target without enrolled TOTP factor was allowed recovery');
    await blocked(()=>proposeAdminMfaRecoveryReview(one.db,
      requester.token,lost.userId,'client-selected-reference',proposeReason,uuid()),
      'Unbounded external support reference was accepted');
    await blocked(()=>proposeAdminMfaRecoveryReview(one.db,
      requester.token,lost.userId,ticket,'too short',uuid()),
      'Insufficient identity-verification reason was accepted');
    await blocked(()=>proposeAdminMfaRecoveryReview(one.db,
      requester.token,lost.userId,ticket,proposeReason,'client-request-id'),
      'Client-controlled malformed trace ID was accepted');

    const opened=await proposeAdminMfaRecoveryReview(
      one.db,requester.token,lost.userId,ticket,proposeReason,uuid());
    check(opened.changed&&opened.status==='pending'&&
      opened.targetUserId===lost.userId&&
      new Date(opened.expiresAt).getTime()>Date.now(),
      'Recovery request did not persist a 24h pending human-review record');
    const duplicate=await proposeAdminMfaRecoveryReview(
      one.db,requester.token,lost.userId,ticket,proposeReason,uuid());
    check(!duplicate.changed&&duplicate.id===opened.id,
      'Repeated recovery proposal created duplicate case/audit');
    await blocked(()=>proposeAdminMfaRecoveryReview(
      one.db,reviewerA.token,lost.userId,
      'REC-FOREIGN-'+uuid().slice(0,12).toUpperCase(),proposeReason,uuid()),
      'Competing support reference silently replaced an active case');

    await blocked(()=>approveAdminMfaRecoveryReview(
      one.db,requester.token,opened.id,ticket,approveReason,uuid()),
      'Original proposer approved their own MFA recovery');
    await blocked(()=>approveAdminMfaRecoveryReview(
      one.db,lost.token,opened.id,ticket,approveReason,uuid()),
      'Target without MFA approved own factor reset');
    await blocked(()=>approveAdminMfaRecoveryReview(
      one.db,ordinary.token,opened.id,ticket,approveReason,uuid()),
      'Ordinary user approved privileged MFA recovery');
    await blocked(()=>approveAdminMfaRecoveryReview(
      one.db,reviewerA.token,opened.id,'REC-FOREIGN-BADREF',approveReason,uuid()),
      'Reviewer bypassed support-ticket match');

    // Two independently verified superadmins on distinct DB pools race.
    // Exactly one may approve; BOTH successful return paths are non-secret.
    const decisions=await Promise.all([
      approveAdminMfaRecoveryReview(one.db,reviewerA.token,
        opened.id,ticket,approveReason,uuid()),
      approveAdminMfaRecoveryReview(two.db,reviewerB.token,
        opened.id,ticket,approveReason,uuid()),
    ]);
    check(decisions.filter(x=>x.changed).length===1&&
      decisions.filter(x=>!x.changed).length===1&&
      decisions.every(x=>x.status==='approved'),
      'Two approval writers bypassed uniqueness or concurrency fences');
    const [approved]=await one.db.select().from(schema.adminMfaRecoveryRequests)
      .where(eq(schema.adminMfaRecoveryRequests.id,opened.id));
    check(approved?.status==='approved'&&
      approved.proposedBy===requester.userId&&
      [reviewerA.userId,reviewerB.userId].includes(approved.approvedBy??'')&&
      approved.approvedBy!==approved.proposedBy&&!!approved.approvedAt,
      'Approval persisted an untrusted or same-person second signer');
    check((await one.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,lost.userId)))[0]?.ciphertext===
      beforeFactor.ciphertext,
      'Review approval secretly rotated or reset TOTP ciphertext');
    check((await one.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,lost.userId)))[0]
      ?.lastAcceptedStep===beforeFactor.lastAcceptedStep,
      'Recovery proposal reset replay fence');
    check((await one.db.select().from(schema.adminSessionMfa)
      .where(eq(schema.adminSessionMfa.userId,lost.userId))).length===0,
      'Review approval granted recovery subject a new MFA session');
    const approvedAgain=await approveAdminMfaRecoveryReview(
      two.db,reviewerA.token,opened.id,ticket,approveReason,uuid());
    check(!approvedAgain.changed,'Approved recovery review emitted duplicate approval');

    const canceled=await cancelAdminMfaRecoveryReview(one.db,
      requester.token,opened.id,cancelReason,uuid());
    check(canceled.changed&&canceled.status==='cancelled',
      'Verified operator could not cancel approved but unexecuted case');
    const canceledAgain=await cancelAdminMfaRecoveryReview(two.db,
      reviewerB.token,opened.id,cancelReason,uuid());
    check(!canceledAgain.changed,'Repeated cancellation wrote a second audit');
    await blocked(()=>approveAdminMfaRecoveryReview(
      two.db,reviewerB.token,opened.id,ticket,approveReason,uuid()),
      'Cancelled factor recovery review could be resurrected');

    // Partial unique index permits exactly ONE active per target even when
    // two superadmins propose from independent real PostgreSQL pools.
    const newTicket='REC-SECOND-'+uuid().slice(0,18).toUpperCase();
    const secondProposals=await Promise.all([
      proposeAdminMfaRecoveryReview(one.db,requester.token,
        lost.userId,newTicket,proposeReason,uuid()),
      proposeAdminMfaRecoveryReview(two.db,reviewerA.token,
        lost.userId,newTicket,proposeReason,uuid()),
    ]);
    check(secondProposals.filter(x=>x.changed).length===1&&
      secondProposals.filter(x=>!x.changed).length===1&&
      secondProposals[0]?.id===secondProposals[1]?.id,
      'Concurrent new proposals bypassed single-open-target index');
    const currentId=secondProposals[0]!.id;
    // Simulated expiry ONLY on Folio folio_test fixture: no scheduler or
    // production tool may edit timestamps. Respect DB <=24h CHECK.
    const old=new Date(Date.now()-26*60*60*1000);
    await one.db.update(schema.adminMfaRecoveryRequests).set({
      createdAt:old,
      expiresAt:new Date(old.getTime()+24*60*60*1000),
    }).where(eq(schema.adminMfaRecoveryRequests.id,currentId));
    const thirdTicket='REC-EXPIRED-'+uuid().slice(0,18).toUpperCase();
    const reopened=await proposeAdminMfaRecoveryReview(
      one.db,requester.token,lost.userId,thirdTicket,proposeReason,uuid());
    check(reopened.changed&&reopened.id!==currentId,
      'Expired review prevented later fully audited independent request');
    const [expired]=await two.db.select().from(schema.adminMfaRecoveryRequests)
      .where(eq(schema.adminMfaRecoveryRequests.id,currentId));
    check(expired?.status==='expired'&&!!expired.closedAt,
      'Expired review was not durably closed before opening a new request');
    await blocked(()=>approveAdminMfaRecoveryReview(
      two.db,reviewerA.token,currentId,newTicket,approveReason,uuid()),
      'Expired review was approved');
    const finalCancel=await cancelAdminMfaRecoveryReview(
      one.db,requester.token,reopened.id,cancelReason,uuid());
    check(finalCancel.status==='cancelled',
      'Cannot cancel newly reopened unexecuted review');
    const finalFactor=await two.db.select().from(schema.adminTotpCredentials)
      .where(eq(schema.adminTotpCredentials.userId,lost.userId));
    check(JSON.stringify(finalFactor[0])===JSON.stringify(beforeFactor),
      'Recovery review changed active factor/replay/lockout record at any point');
    const allProofs=await one.db.select().from(schema.adminSessionMfa)
      .where(eq(schema.adminSessionMfa.userId,lost.userId));
    check(allProofs.length===0,'A proposed/reviewed/cancelled case minted victim MFA proof');

    const requests=await one.db.select().from(schema.adminMfaRecoveryRequests)
      .where(eq(schema.adminMfaRecoveryRequests.targetUserId,lost.userId));
    check(requests.length===3&&
      requests.every(r=>!['pending','approved'].includes(r.status)),
      'Case history was overwritten or left a live review');
    const audit=await one.db.select().from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityType,'admin_mfa_recovery_request'),
        inArray(schema.auditEvents.entityId,requests.map(x=>x.id))));
    for(const [action,count] of [
      ['admin.mfa.recovery.review.proposed',3],
      ['admin.mfa.recovery.review.approved',1],
      ['admin.mfa.recovery.review.cancelled',2],
      ['admin.mfa.recovery.review.expired',1],
    ] as const){
      check(audit.filter(event=>event.action===action).length===count,
        'Recovery event count or monotonic audit mismatched: '+action);
    }
    const auditText=JSON.stringify(audit);
    for(const forbidden of [
      key,password,requester.token,reviewerA.token,reviewerB.token,lost.token,
      beforeFactor.ciphertext,
    ]){
      check(!auditText.includes(forbidden),
        'Recovery audit leaked MFA encryption key, ciphertext, or raw bearer');
    }
    // Persistent CHECK prevents a fabricated second signature even through
    // direct SQL: no status=approved without approved_by and approved_at.
    await blocked(async()=>{
      await one.db.insert(schema.adminMfaRecoveryRequests).values({
        targetUserId:lost.userId,proposedBy:requester.userId,
        proposalReference:'REC-INVALID-FAKE',reason:proposeReason,
        status:'approved',createdAt:new Date(),
        expiresAt:new Date(Date.now()+12*60*60*1000),
      });
    }, 'DB accepted fabricated approved case without independent approver');
    console.log('ADMIN MFA RECOVERY REVIEW PASS: real MFA-superadmin proposer and independent signer, 24h expiry, case-reference match, one-open unique index, two-pool races, immutable audit and cancellation. NO factor reset or admin bootstrap; Folio folio_test only.');
  }finally{
    await one.pool.end();
    await two.pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
