import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type AuthDb=ReturnType<typeof createFolioDb>['db'];
const policies={
  login:{ip:20,account:5},
  register:{ip:6,account:2},
  password_reset:{ip:10,account:3},
} as const;

const inputSchema=z.object({
  action:z.enum(['login','register','password_reset']),
  trustedClientIp:z.string().trim().min(2).max(80),
  email:z.string().trim().max(254).pipe(z.email()),
  // Dedicated persistent key from a secret manager. Never log, persist or generate
  // a different key per process. This is NOT an HTTP request field.
  hmacKeyHex:z.string().regex(/^[a-fA-F0-9]{64}$/),
}).strict();

export class AuthRateLimitExceeded extends Error {
  constructor(){super('Authentication attempt temporarily limited');this.name='AuthRateLimitExceeded';}
}

function canonicalIp(value:string):string{
  const ip=value.toLowerCase();
  const version=isIP(ip);
  if(version===4)return ip;
  if(version===6){
    // WHATWG URL canonicalizes equivalent expanded/compressed IPv6 notations.
    return new URL('http://['+ip+']/').hostname;
  }
  throw new Error('A trusted valid client IP address is required');
}

/** Digests contain no raw IP or e-mail. Only the trusted server may supply IP/key. */
export function prepareAuthAttemptBuckets(rawInput:unknown){
  const input=inputSchema.parse(rawInput);
  const email=input.email.toLowerCase();
  const ip=canonicalIp(input.trustedClientIp);
  const key=Buffer.from(input.hmacKeyHex,'hex');
  const policy=policies[input.action];
  const buckets=([
    {kind:'ip' as const,value:ip,limit:policy.ip},
    {kind:'account' as const,value:email,limit:policy.account},
  ]).map(entry=>({
    kind:entry.kind,limit:entry.limit,
    digest:createHmac('sha256',key)
      .update('folio.auth.rate.v1\0').update(input.action).update('\0')
      .update(entry.kind).update('\0').update(entry.value).digest('hex'),
  }));
  // All processes lock overlapping buckets in the same deterministic order.
  buckets.sort((a,b)=>a.digest.localeCompare(b.digest));
  return {action:input.action,buckets};
}

/**
 * INTERNAL prerequisite for each public signup/signin/reset request.
 * This function must be called BEFORE any password hash or challenge issuance.
 * Inserting and incrementing *both* buckets in one PostgreSQL transaction
 * prevents parallel workers from admitting more than the fixed-window cap.
 * If either bucket is exhausted the entire transaction is rolled back.
 * Connection errors also reject, never permit an attempt.
 */
export async function consumeAuthAttemptRateLimit(db:AuthDb,rawInput:unknown):Promise<void>{
  const {action,buckets}=prepareAuthAttemptBuckets(rawInput);
  await db.transaction(async tx=>{
    for(const bucket of buckets){
      const [row]=await tx.insert(schema.authAttemptWindows).values({
        bucketKey:bucket.digest,kind:bucket.kind,action,
        windowStart:sql`date_bin(interval '15 minutes', now(), timestamptz '2000-01-01')`,
        attempts:1,
      }).onConflictDoUpdate({
        target:[schema.authAttemptWindows.bucketKey,schema.authAttemptWindows.windowStart],
        set:{attempts:sql`${schema.authAttemptWindows.attempts}+1`},
        setWhere:sql`${schema.authAttemptWindows.attempts} < ${bucket.limit}`,
      }).returning({attempts:schema.authAttemptWindows.attempts});
      if(!row)throw new AuthRateLimitExceeded();
    }
  });
}

/** Bounded expiry pruning, for a future Folio-owned scheduled housekeeping job. */
export async function pruneExpiredAuthAttemptWindows(db:AuthDb,maxRows=500){
  const limit=z.number().int().min(1).max(1000).parse(maxRows);
  const result=await db.execute(sql`
    WITH expired AS (
      SELECT ctid FROM auth_attempt_windows
      WHERE window_start < now() - interval '48 hours'
      ORDER BY window_start LIMIT ${limit}
    )
    DELETE FROM auth_attempt_windows AS a USING expired
    WHERE a.ctid=expired.ctid
    RETURNING a.bucket_key
  `);
  return {deleted:result.rows.length};
}
