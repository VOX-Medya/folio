import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createFolioDb,registerPendingAccount,verifyAccountEmail,
  getVerifiedUserOnboarding,updateVerifiedUserOnboarding,schema} from '../src/index.js';

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
    const pending=await registerPendingAccount(first.db,
      'synthetic-onboard-'+randomUUID()+'@example.com','Safe-Test-Passphrase-2026!');
    await denied(()=>getVerifiedUserOnboarding(second.db,pending.userId),
      'Unverified account can read onboarding');
    await denied(()=>updateVerifiedUserOnboarding(second.db,pending.userId,{
      expectedVersion:0,stage:'language',locale:'en',interests:[],
    }),'Unverified account updated onboarding');
    await verifyAccountEmail(first.db,pending.verificationToken);
    const initial=await getVerifiedUserOnboarding(second.db,pending.userId);
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

    console.log('ONBOARDING PASS: verified-only, stage order, TR/EN, 2-pool optimistic conflict, privacy-completion denied with no audit/version change, exact 2 preference audits, cross-device persistence, disabled account denied. Synthetic Folio DB only.');
  }finally{
    await first.pool.end();await second.pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
