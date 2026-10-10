import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {AuthRateLimitExceeded,consumeAuthAttemptRateLimit,
  createFolioDb,prepareAuthAttemptBuckets,pruneExpiredAuthAttemptWindows,
  schema} from '../src/index.js';

function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function denied(fn:()=>Promise<unknown>,message:string){
  let rejected=false;
  try{await fn();}catch(e){rejected=e instanceof AuthRateLimitExceeded;}
  check(rejected,message);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio test DB required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||!['127.0.0.1','localhost'].includes(parsed.hostname)||
     parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Auth rate smoke only runs on local Folio folio_test DB');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const secret='9'.repeat(64);
  const email='synthetic-limit-'+randomUUID()+'@example.com';
  const ip='192.0.2.72';
  const input=(action:'login'|'register'|'password_reset',
    trustedClientIp:string,accountEmail:string)=>({
      action,trustedClientIp,email:accountEmail,hmacKeyHex:secret,
    });
  try{
    const attempt=input('login',ip,email);
    // Independent pools compete for two PostgreSQL fixed-window counters.
    const raced=await Promise.allSettled(Array.from({length:12},(_,n)=>
      consumeAuthAttemptRateLimit(n%2?first.db:second.db,attempt)));
    check(raced.filter(r=>r.status==='fulfilled').length===5,
      'Concurrent login admission exceeded per-account 5/15m quota');
    check(raced.filter(r=>r.status==='rejected'&&r.reason instanceof AuthRateLimitExceeded).length===7,
      'Counter exhaustion did not return an explicit internal throttle error');
    await denied(()=>consumeAuthAttemptRateLimit(second.db,
      input('login','198.51.100.18',email)),
    'Changing IP bypassed per-account throttle');
    await consumeAuthAttemptRateLimit(first.db,
      input('login',ip,'other-'+randomUUID()+'@example.com'));
    await consumeAuthAttemptRateLimit(first.db,input('register',ip,email));
    await consumeAuthAttemptRateLimit(second.db,input('register',ip,email.toUpperCase()));
    await denied(()=>consumeAuthAttemptRateLimit(first.db,input('register',ip,email)),
      'Registration account bucket exceeded quota');
    await consumeAuthAttemptRateLimit(second.db,input('password_reset',ip,email));

    const prepared=prepareAuthAttemptBuckets(attempt);
    const keys=prepared.buckets.map(b=>b.digest);
    const rows=await first.db.select().from(schema.authAttemptWindows);
    check(rows.filter(r=>keys.includes(r.bucketKey)).length===2,
      'Two authentication throttle dimensions were not persisted');
    const counters=rows.filter(r=>keys.includes(r.bucketKey));
    check(counters.find(r=>r.kind==='account')?.attempts===5,
      'Account counter did not enforce the exact number of allowed attempts');
    const all=JSON.stringify(rows);
    check(!all.includes(email)&&!all.includes(ip)&&!all.includes(secret),
      'Private IP/email/key leaked to throttle table');

    // Prune a synthetic old bucket, leave current 15-minute rows untouched.
    const synthetic='f'.repeat(64);
    await first.db.insert(schema.authAttemptWindows).values({
      bucketKey:synthetic,kind:'ip',action:'login',
      windowStart:new Date('2020-01-01T00:00:00Z'),attempts:1,
    }).onConflictDoNothing();
    const {deleted}=await pruneExpiredAuthAttemptWindows(second.db);
    check(deleted>=1,'Expired buckets were not reclaimed');
    const remaining=await second.db.select().from(schema.authAttemptWindows)
      .where(and(eq(schema.authAttemptWindows.bucketKey,synthetic),
        eq(schema.authAttemptWindows.windowStart,new Date('2020-01-01T00:00:00Z'))));
    check(remaining.length===0,'Expired synthetic bucket remained');
    const active=await second.db.select().from(schema.authAttemptWindows);
    check(active.filter(r=>keys.includes(r.bucketKey)).length===2,
      'Expiry cleanup deleted current authentication buckets');
    console.log('AUTH RATE PASS: cross-pool 5/12 admissions, no IP/account bypass, isolated action quotas, HMAC-only storage and bounded expiry cleanup. Folio test DB only; no public auth routes.');
  }finally{await first.pool.end();await second.pool.end();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
