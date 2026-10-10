import {randomBytes,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createFolioDb,admitAuthAttempt,schema} from '../src/index.js';

function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function denied(fn:()=>Promise<unknown>,message:string){
  let rejected=false;
  try{await fn();}catch{rejected=true;}
  check(rejected,message);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio test DB required');
  const u=new URL(url);
  if(u.pathname!=='/folio_test'||!['localhost','127.0.0.1'].includes(u.hostname)||
    u.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Rate guard tests require only Folio loopback folio_test');
  }
  const one=createFolioDb(url),two=createFolioDb(url);
  const key=randomBytes(32).toString('hex'); // synthetic test secret, never logged/committed
  const address='synthetic-'+randomUUID()+'@example.com';
  const networkIp='192.0.2.73';
  const now=new Date('2026-10-10T06:00:00.000Z');
  const payload={action:'login',email:address,networkIp,hmacKeyHex:key} as const;
  try{
    // Real two-pool simultaneous calls: per-account allowance 5, no sixth.
    const attempts=await Promise.all(Array.from({length:12},(_,index)=>
      admitAuthAttempt(index%2?two.db:one.db,payload,now)));
    check(attempts.filter(a=>a.allowed).length===5,
      'Parallel login guesses exceeded 5-per-account policy');
    check(attempts.filter(a=>!a.allowed).length===7&&
      attempts.filter(a=>!a.allowed).every(a=>a.retryAfterSeconds>0),
      'Rate guard did not block and return a retry delay');
    const differentAction=await admitAuthAttempt(two.db,
      {...payload,action:'reset'},now);
    check(differentAction.allowed,'Login bucket blocked a separate recovery action');

    // Per-network limit must survive randomized account identifiers.
    const networkResponses=[];
    for(let i=0;i<19;i++){
      networkResponses.push(await admitAuthAttempt(i%2?one.db:two.db,{
        ...payload,email:'new-'+randomUUID()+'@example.com',
      },now));
    }
    check(networkResponses.slice(0,18).every(result=>result.allowed)&&
      !networkResponses[18]?.allowed,'Network cap was bypassed by rotating emails');

    const continued=await admitAuthAttempt(one.db,payload,
      new Date(now.getTime()+16*60*1000));
    check(continued.allowed,'Expired rate windows did not reset');

    const ipv6='2001:db8::1';
    const ipv6a=await admitAuthAttempt(one.db,{
      ...payload,action:'signup',networkIp:ipv6,
    },now);
    const ipv6b=await admitAuthAttempt(two.db,{
      ...payload,action:'signup',networkIp:'2001:0DB8:0:0:0:0:0:1',
    },now);
    check(ipv6a.allowed&&ipv6b.allowed,'Canonical IPv6 addresses were rejected');

    await denied(()=>admitAuthAttempt(one.db,{
      ...payload,hmacKeyHex:'', // FAIL-CLOSED without production key
    },now),'Missing HMAC key accepted a network request');
    await denied(()=>admitAuthAttempt(two.db,{
      ...payload,networkIp:'X-Forwarded-For: 203.0.113.5',
    },now),'Untrusted string spoofed a socket remote address');

    const [rows,all]=await Promise.all([
      one.db.select().from(schema.authRateBuckets).where(eq(schema.authRateBuckets.action,'login')),
      one.db.select().from(schema.authRateBuckets),
    ]);
    check(rows.length>=2&&all.length>=4,'Hashed account/network buckets missing');
    const serialized=JSON.stringify(all);
    check(!serialized.includes(address)&&!serialized.includes(networkIp)&&
      !serialized.includes(key)&&!serialized.includes('2001:db8'),
      'Auth abuse bucket stored raw account/IP/secret');
    check(all.every(item=>item.bucketDigest.length===64&&
      /^(account|network)$/.test(item.scope)),'Auth bucket format is not opaque');
    console.log('AUTH RATE PASS: two Postgres pools, 5 account/30 network limit, action separation, rolling reset, IPv6 normalization, fail-closed HMAC/IP, no raw identity at rest.');
  }finally{
    await one.pool.end();await two.pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
