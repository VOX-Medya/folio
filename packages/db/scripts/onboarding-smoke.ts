import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {
  createFolioDb,registerPendingAccount,verifyAccountEmail,
  signInVerifiedAccount,authenticateUserSession,revokeUserSession,
  getVerifiedUserOnboarding,updateVerifiedUserOnboarding,schema,
} from '../src/index.js';

function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function denied(fn:()=>Promise<unknown>,message:string){
  let rejected=false;
  try{await fn();}catch{rejected=true;}
  check(rejected,message);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio test DB required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Onboarding smoke only runs on local Folio folio_test DB');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  try{
    const email='synthetic-onboard-'+randomUUID()+'@example.com';
    const password='Safe-Test-Passphrase-2026!';
    const pending=await registerPendingAccount(first.db,email,password);
    await denied(()=>getVerifiedUserOnboarding(second.db,pending.userId),
      'Unverified account can read onboarding');
    await denied(()=>updateVerifiedUserOnboarding(second.db,pending.userId,{
      expectedVersion:0,stage:'language',locale:'en',interests:[],
    }),'Unverified account updated onboarding');
    await verifyAccountEmail(first.db,pending.verificationToken);
    const primary=await signInVerifiedAccount(first.db,email,password,'web');
    const secondary=await signInVerifiedAccount(second.db,email,password,'android');
    const initial=await getVerifiedUserOnboarding(second.db,pending.userId,primary.sessionId);
    check(initial.stage==='welcome'&&initial.locale==='tr'&&initial.version===0,
      'New user onboarding did not start safely');
    await denied(()=>updateVerifiedUserOnboarding(first.db,pending.userId,{
      expectedVersion:0,stage:'complete',locale:'en',interests:[],
    }),'User skipped mandatory onboarding stages');

    // Same optimistic version from independent devices: exactly one succeeds.
    const race=await Promise.allSettled([
      updateVerifiedUserOnboarding(first.db,pending.userId,{
        expectedVersion:0,stage:'language',locale:'en',interests:[],
      }),
      updateVerifiedUserOnboarding(second.db,pending.userId,{
        expectedVersion:0,stage:'language',locale:'tr',interests:[],
      }),
    ]);
    check(race.filter(result=>result.status==='fulfilled').length===1&&
      race.filter(result=>result.status==='rejected').length===1,
      'Concurrent devices silently overwrote onboarding');
    const current=await getVerifiedUserOnboarding(second.db,pending.userId);
    check(current.stage==='language'&&current.version===1,
      'Successful onboarding version was not persisted');
    await denied(()=>updateVerifiedUserOnboarding(first.db,pending.userId,{
      expectedVersion:0,stage:'language',locale:'tr',interests:[],
    }),'Stale device version did not conflict');

    const next=await updateVerifiedUserOnboarding(second.db,pending.userId,{
      expectedVersion:1,stage:'interests',locale:current.locale,
      interests:['science-fiction','history'],
    });
    check(next.version===2&&next.interests.length===2,'Interest progress was lost');
    // No approved notice version or consent receipt exists. Completion must be
    // impossible through the DB helper, even with a valid account and version.
    await denied(()=>updateVerifiedUserOnboarding(first.db,pending.userId,{
      expectedVersion:2,stage:'complete',locale:current.locale,
      interests:['science-fiction','history'],
    }),'Unapproved privacy policy was bypassed by internal DB completion');
    await denied(()=>updateVerifiedUserOnboarding(second.db,pending.userId,{
      expectedVersion:2,stage:'complete',locale:'tr',
      interests:['science-fiction','history'],
    }),'Other device bypassed missing privacy consent');
    await denied(()=>updateVerifiedUserOnboarding(second.db,pending.userId,{
      expectedVersion:2,stage:'language',locale:'en',interests:[],
    }),'Onboarding stage regression allowed');
    await denied(()=>updateVerifiedUserOnboarding(second.db,pending.userId,{
      expectedVersion:2,stage:'complete',locale:'en',interests:['history','history'],
    }),'Repeated interest category accepted');

    const reloaded=await getVerifiedUserOnboarding(second.db,pending.userId);
    check(JSON.stringify(reloaded)===JSON.stringify(next)&&
      reloaded.stage==='interests'&&reloaded.version===2,
      'Rejected completion changed backend language/interests/version');

    // Emulate a legitimate HTTP guard that authenticated a bearer just BEFORE
    // another device revoked it. The DB must reject the remembered principal
    // even if the old userId/sessionId pair is supplied after revocation.
    const remembered=await authenticateUserSession(second.db,primary.sessionToken);
    check(remembered?.userId===pending.userId&&
      remembered.sessionId===primary.sessionId,
      'Could not create a verified pre-revocation principal');
    const foreign=await registerPendingAccount(first.db,
      'synthetic-onboard-foreign-'+randomUUID()+'@example.com',password);
    await verifyAccountEmail(first.db,foreign.verificationToken);
    const foreignSession=await signInVerifiedAccount(
      first.db,'synthetic-onboard-foreign-'+randomUUID()+'@example.com',password,'foreign',
    ).catch(()=>null);
    // The typed trusted-session ID is validated independently of the bearer.
    // A random foreign owner/session combination must never authenticate.
    await denied(()=>getVerifiedUserOnboarding(
      second.db,pending.userId,foreignSession?.sessionId??randomUUID(),
    ),'Cross-owner session ID read another account onboarding');
    await denied(()=>updateVerifiedUserOnboarding(first.db,pending.userId,{
      expectedVersion:2,stage:'interests',locale:'en',interests:['history'],
    },undefined,foreignSession?.sessionId??randomUUID()),
    'Cross-owner session ID wrote another account onboarding');
    check((await revokeUserSession(first.db,primary.sessionToken)).revoked,
      'Failed to revoke remembered verified bearer before onboarding transaction');
    await denied(()=>getVerifiedUserOnboarding(
      second.db,pending.userId,remembered.sessionId,
    ),'Revoked guard principal read private onboarding after session invalidation');
    await denied(()=>updateVerifiedUserOnboarding(first.db,pending.userId,{
      expectedVersion:2,stage:'interests',locale:'en',interests:['history'],
    },undefined,remembered.sessionId),
    'Revoked guard principal wrote private onboarding after session invalidation');
    const stillAuthorized=await getVerifiedUserOnboarding(
      second.db,pending.userId,secondary.sessionId,
    );
    check(JSON.stringify(stillAuthorized)===JSON.stringify(reloaded),
      'Other live device lost onboarding access after first session was revoked');

    const audits=await first.db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId,pending.userId));
    const preferenceAudits=audits.filter(a=>a.action==='user.onboarding.update');
    check(preferenceAudits.length===2,'Rejected consent completion or conflict added audit');
    check(!JSON.stringify(preferenceAudits).includes('science-fiction'),
      'Audit accidentally copied personal reading interests');
    await first.db.update(schema.userAccounts).set({status:'disabled'})
      .where(eq(schema.userAccounts.id,pending.userId));
    await denied(()=>getVerifiedUserOnboarding(second.db,pending.userId),
      'Disabled account can still retrieve private preference data');

    console.log('ONBOARDING PASS: verified-only, stage order, TR/EN, 2-pool optimistic conflict, privacy-completion denied, revoked/mismatched session IDs fail inside DB transaction with no audit/version change, other active device intact, disabled account denied. Synthetic Folio DB only.');
  }finally{
    await first.pool.end();await second.pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
