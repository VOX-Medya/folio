import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {
  createFolioDb,registerPendingAccount,verifyAccountEmail,
  signInVerifiedAccount,revokeUserSession,
} from '@folio/db';
import {apiErrorSchema,onboardingSnapshotSchema} from '@folio/contracts';
import {createFolioApp} from '../main.js';

function check(value:unknown,msg:string):asserts value{if(!value)throw new Error(msg);}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio CI test database required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Onboarding HTTP smoke must use Folio-only local folio_test database');
  }
  const {db,pool}=createFolioDb(url);
  const pass='Synthetic-Onboarding-HTTP-2026!';
  const newAccount=async()=>{
    const email='synthetic-onboarding-http-'+randomUUID()+'@example.com';
    const pending=await registerPendingAccount(db,email,pass);
    await verifyAccountEmail(db,pending.verificationToken);
    return {...pending,email};
  };
  let app:Awaited<ReturnType<typeof createFolioApp>>|undefined;
  try{
    const first=await newAccount(),second=await newAccount();
    const device1=await signInVerifiedAccount(db,first.email,pass,'web');
    const device2=await signInVerifiedAccount(db,first.email,pass,'android');
    const unrelated=await signInVerifiedAccount(db,second.email,pass,'other-user');
    app=await createFolioApp();
    const listen=await app.listen(0,'127.0.0.1');
    const address=listen.address();
    if(!address||typeof address==='string')throw new Error('No ephemeral HTTP port');
    const endpoint=`http://127.0.0.1:${address.port}/v1/me/onboarding`;
    const headers=(token:string)=>({
      authorization:'Bearer '+token,'content-type':'application/json',
      'x-user-id':second.userId,'x-admin-role':'superadmin',
      'x-request-id':'attacker-id',
    });
    const patch=(token:string,body:unknown)=>fetch(endpoint,{
      method:'PATCH',headers:headers(token),body:JSON.stringify(body),
    });
    const spoof=await fetch(endpoint,{headers:{
      'x-user-id':first.userId,'x-admin-role':'superadmin','x-request-id':'attacker-id',
    }});
    check(spoof.status===401,'Unverified spoof headers read a private onboarding profile');
    const spoofError=apiErrorSchema.parse(await spoof.json());
    check(spoofError.error.requestId===spoof.headers.get('x-request-id')&&
      spoofError.error.requestId!=='attacker-id','Authentication error echoed client request-id');
    check(spoof.headers.get('cache-control')?.includes('no-store'),
      'Unauthorized private response was cacheable');

    const firstRead=await fetch(endpoint,{headers:headers(device1.sessionToken)});
    check(firstRead.status===200,'Verified account cannot retrieve onboarding HTTP route');
    const initial=onboardingSnapshotSchema.parse(await firstRead.json());
    check(initial.userId===first.userId&&initial.stage==='welcome'&&initial.version===0,
      'Initial onboarding leaked another user or skipped default stage');
    check(firstRead.headers.get('cache-control')?.includes('no-store'),
      'Private onboarding HTTP response was cacheable');
    // Native bearer must not silently become browser authentication. These
    // spoofed browser metadata headers are rejected before owned DB access.
    for(const browserMetadata of [
      {origin:'https://reader.example.org'},
      {'sec-fetch-site':'same-origin'},
      {'sec-fetch-site':'cross-site'},
    ]){
      const denied=await fetch(endpoint,{headers:{
        ...headers(device1.sessionToken),...browserMetadata,
      }});
      check(denied.status===401,'Browser-origin bearer read private onboarding');
      const denial=apiErrorSchema.parse(await denied.json());
      check(denial.error.code==='UNAUTHORIZED'&&
        denial.error.requestId===denied.headers.get('x-request-id')&&
        denied.headers.get('cache-control')?.includes('no-store'),
        'Browser bearer denial leaked or lost HTTP error/cache contract');
    }
    const browserMutation=await fetch(endpoint,{
      method:'PATCH',
      headers:{...headers(device1.sessionToken),origin:'https://reader.example.org'},
      body:JSON.stringify({expectedVersion:0,stage:'language',locale:'en',interests:[]}),
    });
    check(browserMutation.status===401,'Browser-origin bearer updated private onboarding');
    check((await fetch(endpoint+'?userId='+second.userId,{
      headers:headers(device1.sessionToken)})).status===400,
      'Untrusted query selected another principal');
    const other=onboardingSnapshotSchema.parse(await (await fetch(endpoint,{
      headers:headers(unrelated.sessionToken)})).json());
    check(other.userId===second.userId&&other.version===0,
      'Unrelated account could read first account onboarding');

    const invalid=await patch(device1.sessionToken,{
      expectedVersion:0,stage:'language',locale:'en',interests:[],
      userId:second.userId,
    });
    check(invalid.status===400,'User-selected ownership field was accepted');
    const skipped=await patch(device1.sessionToken,{
      expectedVersion:0,stage:'complete',locale:'en',interests:[],
    });
    check(skipped.status===400,'Stage-skip update was allowed');
    const payload={expectedVersion:0,stage:'language',locale:'en',interests:[]};
    const save=await patch(device1.sessionToken,payload);
    check(save.status===200,'Verified bearer PATCH failed');
    const newSnapshot=onboardingSnapshotSchema.parse(await save.json());
    check(newSnapshot.userId===first.userId&&newSnapshot.version===1&&
      newSnapshot.stage==='language','Onboarding PATCH was not atomic');

    const sameStale=await patch(device2.sessionToken,payload);
    check(sameStale.status===409,'Second device overwrote stale onboarding progress');
    const conflict=apiErrorSchema.parse(await sameStale.json());
    check(conflict.error.code==='CONFLICT'&&
      conflict.error.requestId===sameStale.headers.get('x-request-id'),
      'Conflict HTTP code/request ID contract was wrong');
    const persisted=onboardingSnapshotSchema.parse(await (await fetch(endpoint,{
      headers:headers(device2.sessionToken),
    })).json());
    check(persisted.version===1&&persisted.locale==='en',
      'Other device did not reload saved backend preference');
    const interests=await patch(device2.sessionToken,{
      expectedVersion:1,stage:'interests',locale:'en',interests:['science-fiction','history'],
    });
    check(interests.status===200,'Validated interest progression was not saved');
    const interestsSaved=onboardingSnapshotSchema.parse(await interests.json());
    check(interestsSaved.version===2&&interestsSaved.interests.length===2,
      'Interest choice lost on update');

    // A crafted direct HTTP PATCH must not bypass the unavailable privacy
    // consent flow. No version increment, audit row or user status change.
    const completion=await patch(device2.sessionToken,{
      expectedVersion:2,stage:'complete',locale:'en',
      interests:['science-fiction','history'],
    });
    check(completion.status===403,'Missing privacy consent allowed HTTP completion');
    const completionError=apiErrorSchema.parse(await completion.json());
    check(completionError.error.code==='FORBIDDEN'&&
      completionError.error.requestId===completion.headers.get('x-request-id')&&
      completionError.error.requestId!=='attacker-id',
      'Denied consent completion lost safe error/request-id contract');
    const fakeConsent=await patch(device2.sessionToken,{
      expectedVersion:2,stage:'complete',locale:'en',
      interests:['science-fiction','history'],privacyConsent:true,
    });
    check(fakeConsent.status===400,'Caller-invented privacy consent field accepted');
    const afterDenied=onboardingSnapshotSchema.parse(await (await fetch(endpoint,{
      headers:headers(device1.sessionToken),
    })).json());
    check(afterDenied.stage==='interests'&&afterDenied.version===2&&
      JSON.stringify(afterDenied.interests)===JSON.stringify(interestsSaved.interests),
      'Rejected completion damaged persisted onboarding progress');

    const audits=await pool.query<{
      action:string;request_id:string|null;before_json:unknown;after_json:unknown;
    }>('SELECT action, request_id, before_json, after_json FROM audit_events WHERE actor_id=$1::uuid',
      [first.userId]);
    const updates=audits.rows.filter(a=>a.action==='user.onboarding.update');
    check(updates.length===2,'Denied/duplicate update changed persisted audit count');
    const requestId=save.headers.get('x-request-id');
    check(updates.some(row=>row.request_id===requestId),
      'Audit event lacks server-issued HTTP request-id correlation');
    check(!JSON.stringify(updates).includes('science-fiction'),
      'Private selected interest list leaked into audit trail');

    check((await revokeUserSession(db,device1.sessionToken)).revoked,
      'First device token not revoked');
    check((await fetch(endpoint,{headers:headers(device1.sessionToken)})).status===401,
      'Revoked bearer could still read own onboarding');
    const rejectedMutation=await patch(device1.sessionToken,{
      expectedVersion:2,stage:'interests',locale:'tr',interests:['history'],
    });
    check(rejectedMutation.status===401,'Revoked bearer updated onboarding after logout');
    const rejectedError=apiErrorSchema.parse(await rejectedMutation.json());
    check(rejectedError.error.code==='UNAUTHORIZED'&&
      rejectedError.error.requestId===rejectedMutation.headers.get('x-request-id'),
      'Revoked bearer mutation leaked details or lost trusted request ID');
    const stillValid=await fetch(endpoint,{headers:headers(device2.sessionToken)});
    check(stillValid.status===200,'Revoking one device broke another');
    await pool.query('UPDATE user_accounts SET status=$1 WHERE id=$2::uuid',
      ['disabled',first.userId]);
    check((await fetch(endpoint,{headers:headers(device2.sessionToken)})).status===401,
      'Disabled account retained authenticated onboarding access');

    const documentResponse=await fetch(`http://127.0.0.1:${address.port}/openapi-json`);
    check(documentResponse.status===200,'OpenAPI missing on live HTTP');
    const document=await documentResponse.json() as {paths:Record<string,Record<string,unknown>>};
    check(!!document.paths['/v1/me/onboarding']?.get&&
      !!document.paths['/v1/me/onboarding']?.patch,
      'Private onboarding GET/PATCH missing from versioned OpenAPI');

    console.log('ONBOARDING HTTP PASS: verified-only self GET/PATCH, spoofed principals 401, client userId/query 400, optimistic conflict 409, unapproved completion 403, forged consent field 400, cross-device resumption, no-store, request-id audit, revoke/disabled 401, OpenAPI. Folio synthetic test DB only.');
  }finally{
    if(app)await app.close();
    await pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
