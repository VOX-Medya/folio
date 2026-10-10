import {createHash,randomBytes,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {and,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type AuthDb=ReturnType<typeof createFolioDb>['db'];
const scrypt=promisify(scryptCallback);
const emailSchema=z.email().trim().max(254).transform(value=>value.toLowerCase());
const passwordSchema=z.string().min(12).max(128).refine(value=>!value.includes('\0'));
const deviceSchema=z.string().trim().min(1).max(80);
type Purpose='verify_email'|'password_reset';
const SESSION_DAYS=30;
const challengeTtlMs=15*60*1000;

const token=()=>randomBytes(32).toString('base64url');
const tokenHash=(raw:string)=>createHash('sha256').update(raw,'ascii').digest('hex');
function rawToken(value:string):string {
  if(!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('Invalid authentication challenge');
  return value;
}
function passwordSalt(){return randomBytes(16).toString('hex');}
async function derive(password:string,salt:string):Promise<string>{
  const result=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  return result.toString('hex');
}
async function validatePassword(password:string,salt:string,expected:string):Promise<boolean>{
  const actual=Buffer.from(await derive(password,salt),'hex');
  const expectedBytes=Buffer.from(expected,'hex');
  return expectedBytes.length===64&&timingSafeEqual(actual,expectedBytes);
}
function expired(expiresAt:Date){return expiresAt.getTime()<=Date.now();}
const genericLoginFailure=()=>new Error('Invalid login credentials or unavailable account');

async function createChallenge(tx:Parameters<Parameters<AuthDb['transaction']>[0]>[0],
  userId:string,purpose:Purpose,expiresAt:Date){
  const secret=token();
  const [challenge]=await tx.insert(schema.authChallenges).values({
    userId,purpose,tokenDigest:tokenHash(secret),expiresAt,
  }).returning({id:schema.authChallenges.id});
  if(!challenge)throw new Error('Challenge creation failed');
  return secret;
}

/**
 * INTERNAL ONLY. Return the one-use email token to a trusted mail dispatcher.
 * NEVER expose this return value in any client HTTP signup response.
 */
export async function registerPendingAccount(db:AuthDb,rawEmail:string,rawPassword:string){
  const email=emailSchema.parse(rawEmail);
  const password=passwordSchema.parse(rawPassword);
  const salt=passwordSalt();
  const digest=await derive(password,salt);
  return db.transaction(async tx=>{
    const [account]=await tx.insert(schema.userAccounts).values({
      normalizedEmail:email,status:'pending_email',
    }).returning({id:schema.userAccounts.id});
    if(!account)throw new Error('Pending account creation failed');
    await tx.insert(schema.passwordCredentials).values({
      userId:account.id,passwordSalt:salt,passwordDigest:digest,scheme:'scrypt-v1',
    });
    const verificationToken=await createChallenge(tx,account.id,'verify_email',
      new Date(Date.now()+challengeTtlMs));
    await tx.insert(schema.auditEvents).values({
      actorId:account.id,action:'auth.account.pending',entityType:'user_account',entityId:account.id,
      afterJson:{status:'pending_email'}, // NO email, password or raw token
    });
    return {userId:account.id,verificationToken};
  });
}

async function consumeChallenge(db:AuthDb,secret:string,purpose:Purpose,
  mutate:(tx:Parameters<Parameters<AuthDb['transaction']>[0]>[0],userId:string)=>Promise<void>){
  const digest=tokenHash(rawToken(secret));
  return db.transaction(async tx=>{
    // Match owner lock order across verification, recovery issuance and reset.
    const [lookup]=await tx.select({userId:schema.authChallenges.userId})
      .from(schema.authChallenges).where(and(eq(schema.authChallenges.tokenDigest,digest),
        eq(schema.authChallenges.purpose,purpose))).limit(1);
    if(!lookup)throw new Error('Invalid or expired authentication challenge');
    const [account]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,lookup.userId)).limit(1).for('update');
    if(!account||account.status==='disabled')throw new Error('Invalid or expired authentication challenge');
    const [challenge]=await tx.select().from(schema.authChallenges)
      .where(and(eq(schema.authChallenges.tokenDigest,digest),
        eq(schema.authChallenges.purpose,purpose))).limit(1).for('update');
    if(!challenge||challenge.userId!==account.id||challenge.consumedAt||expired(challenge.expiresAt)){
      throw new Error('Invalid or expired authentication challenge');
    }
    await mutate(tx,account.id);
    await tx.update(schema.authChallenges).set({consumedAt:new Date()})
      .where(eq(schema.authChallenges.id,challenge.id));
    return {userId:account.id};
  });
}

export async function verifyAccountEmail(db:AuthDb,verificationToken:string){
  return consumeChallenge(db,verificationToken,'verify_email',async(tx,userId)=>{
    const [account]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,userId)).limit(1);
    if(!account||account.status!=='pending_email'||account.emailVerifiedAt){
      throw new Error('Email is already verified or unavailable');
    }
    await tx.update(schema.userAccounts).set({status:'active',emailVerifiedAt:new Date()})
      .where(eq(schema.userAccounts.id,userId));
    await tx.insert(schema.auditEvents).values({
      actorId:userId,action:'auth.email.verified',entityType:'user_account',entityId:userId,
      afterJson:{status:'active'},
    });
  });
}

/** Only trusted dispatchers can see the reset token. HTTP responses must be generic. */
export async function issuePasswordResetChallenge(db:AuthDb,rawEmail:string){
  const email=emailSchema.parse(rawEmail);
  return db.transaction(async tx=>{
    const [candidate]=await tx.select({id:schema.userAccounts.id})
      .from(schema.userAccounts).where(eq(schema.userAccounts.normalizedEmail,email)).limit(1);
    if(!candidate)return null;
    const [account]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,candidate.id)).limit(1).for('update');
    if(!account||account.status!=='active'||!account.emailVerifiedAt)return null;
    await tx.update(schema.authChallenges).set({consumedAt:new Date()})
      .where(and(eq(schema.authChallenges.userId,account.id),
        eq(schema.authChallenges.purpose,'password_reset'),isNull(schema.authChallenges.consumedAt)));
    const resetToken=await createChallenge(tx,account.id,'password_reset',
      new Date(Date.now()+challengeTtlMs));
    await tx.insert(schema.auditEvents).values({
      actorId:account.id,action:'auth.reset.requested',entityType:'user_account',entityId:account.id,
      afterJson:{purpose:'password_reset'}, // NO raw token or recipient
    });
    return {userId:account.id,resetToken};
  });
}

/** Reset invalidates EVERY device session in the same transaction as credentials. */
export async function resetAccountPassword(db:AuthDb,resetToken:string,newPassword:string){
  const pass=passwordSchema.parse(newPassword);
  const salt=passwordSalt(),digest=await derive(pass,salt);
  return consumeChallenge(db,resetToken,'password_reset',async(tx,userId)=>{
    const [account]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,userId)).limit(1);
    if(!account||account.status!=='active'||!account.emailVerifiedAt){
      throw new Error('Account cannot reset password');
    }
    await tx.update(schema.passwordCredentials).set({
      passwordSalt:salt,passwordDigest:digest,scheme:'scrypt-v1',updatedAt:new Date(),
    }).where(eq(schema.passwordCredentials.userId,userId));
    await tx.update(schema.userSessions).set({revokedAt:new Date()})
      .where(and(eq(schema.userSessions.userId,userId),isNull(schema.userSessions.revokedAt)));
    await tx.insert(schema.auditEvents).values({
      actorId:userId,action:'auth.password.reset',entityType:'user_account',entityId:userId,
      afterJson:{sessionsRevoked:true},
    });
  });
}

/**
 * INTERNAL only until rate limits, trusted verified-email dispatch, cookie/CSRF,
 * secure native key storage and admin MFA are implemented.
 */
export async function signInVerifiedAccount(
  db:AuthDb,rawEmail:string,rawPassword:string,rawDeviceLabel:string
){
  const email=emailSchema.parse(rawEmail);
  const password=passwordSchema.parse(rawPassword);
  const deviceLabel=deviceSchema.parse(rawDeviceLabel);
  const [account]=await db.select().from(schema.userAccounts)
    .where(eq(schema.userAccounts.normalizedEmail,email)).limit(1);
  const [credential]=account?await db.select().from(schema.passwordCredentials)
    .where(eq(schema.passwordCredentials.userId,account.id)).limit(1):[];
  // Always do an expensive slow hash, even for nonexistent accounts.
  const legitimate=credential?.scheme==='scrypt-v1'&&account?.status==='active'&&!!account.emailVerifiedAt;
  const matched=await validatePassword(password,credential?.passwordSalt??'0'.repeat(32),
    credential?.passwordDigest??'0'.repeat(128));
  if(!legitimate||!matched||!account||!credential)throw genericLoginFailure();
  return db.transaction(async tx=>{
    const [current]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,account.id)).limit(1).for('update');
    const [nowCredential]=await tx.select().from(schema.passwordCredentials)
      .where(eq(schema.passwordCredentials.userId,account.id)).limit(1);
    if(!current||current.status!=='active'||!current.emailVerifiedAt||!nowCredential||
      nowCredential.passwordDigest!==credential.passwordDigest||
      nowCredential.passwordSalt!==credential.passwordSalt)throw genericLoginFailure();
    const bearer=token();
    const [session]=await tx.insert(schema.userSessions).values({
      userId:account.id,tokenDigest:tokenHash(bearer),deviceLabel,
      expiresAt:new Date(Date.now()+SESSION_DAYS*86400000),
    }).returning({id:schema.userSessions.id,expiresAt:schema.userSessions.expiresAt});
    if(!session)throw new Error('Session creation failed');
    await tx.insert(schema.auditEvents).values({
      actorId:account.id,action:'auth.session.created',entityType:'user_session',entityId:session.id,
      afterJson:{deviceLabel,expiresAt:session.expiresAt.toISOString()},
    });
    return {userId:account.id,sessionId:session.id,sessionToken:bearer,expiresAt:session.expiresAt};
  });
}

/** Internal trust boundary: a caller's user ID is derived solely from hashed bearer lookup. */
export async function authenticateUserSession(db:AuthDb,sessionToken:string){
  if(!/^[A-Za-z0-9_-]{43}$/.test(sessionToken))return null;
  const [session]=await db.select().from(schema.userSessions)
    .where(eq(schema.userSessions.tokenDigest,tokenHash(sessionToken))).limit(1);
  if(!session||session.revokedAt||expired(session.expiresAt))return null;
  const [user]=await db.select().from(schema.userAccounts)
    .where(eq(schema.userAccounts.id,session.userId)).limit(1);
  if(!user||user.status!=='active'||!user.emailVerifiedAt)return null;
  return {userId:user.id,sessionId:session.id}; // No admin role grants here
}

export async function revokeUserSession(db:AuthDb,sessionToken:string){
  const digest=tokenHash(rawToken(sessionToken));
  return db.transaction(async tx=>{
    const [existing]=await tx.select().from(schema.userSessions)
      .where(eq(schema.userSessions.tokenDigest,digest)).limit(1).for('update');
    if(!existing)return {revoked:false};
    if(existing.revokedAt)return {revoked:false};
    await tx.update(schema.userSessions).set({revokedAt:new Date()})
      .where(eq(schema.userSessions.id,existing.id));
    await tx.insert(schema.auditEvents).values({
      actorId:existing.userId,action:'auth.session.revoked',
      entityType:'user_session',entityId:existing.id,
      afterJson:{revoked:true},
    });
    return {revoked:true};
  });
}

export async function revokeAllUserSessions(db:AuthDb,sessionToken:string){
  const digest=tokenHash(rawToken(sessionToken));
  return db.transaction(async tx=>{
    const [lookup]=await tx.select().from(schema.userSessions)
      .where(eq(schema.userSessions.tokenDigest,digest)).limit(1);
    if(!lookup)throw new Error('Authenticated session required');
    const [user]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,lookup.userId)).limit(1).for('update');
    const [session]=await tx.select().from(schema.userSessions)
      .where(eq(schema.userSessions.id,lookup.id)).limit(1).for('update');
    if(!user||user.status!=='active'||!user.emailVerifiedAt||
      !session||session.revokedAt||expired(session.expiresAt)){
      throw new Error('Authenticated session required');
    }
    await tx.update(schema.userSessions).set({revokedAt:new Date()})
      .where(and(eq(schema.userSessions.userId,user.id),isNull(schema.userSessions.revokedAt)));
    await tx.insert(schema.auditEvents).values({
      actorId:user.id,action:'auth.sessions.revoke_all',
      entityType:'user_account',entityId:user.id,afterJson:{allSessionsRevoked:true},
    });
    return {revoked:true};
  });
}
