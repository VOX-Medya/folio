import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type OnboardingDb=ReturnType<typeof createFolioDb>['db'];
const id=z.uuid();
const interests=z.array(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/)).max(20)
  .refine(values=>new Set(values).size===values.length,{message:'Duplicate interest IDs'});
const stages=['welcome','language','interests','complete'] as const;
type Stage=(typeof stages)[number];
const updateSchema=z.object({
  expectedVersion:z.number().int().nonnegative().max(2147483646),
  stage:z.enum(stages),
  locale:z.enum(['tr','en']),
  interests,
}).strict();

function snapshot(userId:string,row:typeof schema.userOnboarding.$inferSelect|undefined){
  return {userId,stage:row?.stage??'welcome',locale:row?.locale??'tr',
    interests:row?.interests??[],version:row?.version??0};
}

/**
 * A session verified earlier in HTTP middleware can be revoked before the
 * actual database operation starts. Lock the account FIRST, then the exact
 * owned session row, preserving the owner-before-session lock ordering of
 * verified device revocation. The lock serializes revocation vs. mutation.
 *
 * The optional session ID is for trusted internal CLI/test usage only.
 * Every real /v1/me API call MUST supply a DB-verified guard principal.
 */
async function assertActiveTrustedSession(
  tx:Parameters<Parameters<OnboardingDb['transaction']>[0]>[0],
  userId:string,sessionId:string|undefined,
):Promise<void>{
  if(sessionId===undefined)return;
  const [session]=await tx.select({
    revokedAt:schema.userSessions.revokedAt,
    expiresAt:schema.userSessions.expiresAt,
  }).from(schema.userSessions).where(and(
    eq(schema.userSessions.userId,userId),
    eq(schema.userSessions.id,sessionId),
  )).limit(1).for('share');
  if(!session||session.revokedAt||session.expiresAt.getTime()<=Date.now()){
    throw new Error('Verified session required');
  }
}

/** INTERNAL: only an authenticated, email-verified principal may read user preferences. */
export async function getVerifiedUserOnboarding(
  db:OnboardingDb,trustedUserId:string,trustedSessionId?:string,
){
  const userId=id.parse(trustedUserId);
  const sessionId=trustedSessionId===undefined?undefined:id.parse(trustedSessionId);
  return db.transaction(async tx=>{
    const [user]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,userId)).limit(1).for('share');
    if(!user||user.status!=='active'||!user.emailVerifiedAt){
      throw new Error('Verified user required for onboarding');
    }
    await assertActiveTrustedSession(tx,userId,sessionId);
    const [row]=await tx.select().from(schema.userOnboarding)
      .where(eq(schema.userOnboarding.userId,userId)).limit(1);
    return snapshot(userId,row);
  });
}

/**
 * Server row-lock + exact optimistic version prevents independent devices from
 * overwriting each other's language/interests silently. A conflict is explicit.
 */
export async function updateVerifiedUserOnboarding(
  db:OnboardingDb,trustedUserId:string,rawUpdate:unknown,
  requestId?:string,trustedSessionId?:string,
){
  const userId=id.parse(trustedUserId),input=updateSchema.parse(rawUpdate);
  const trustedRequestId=requestId?z.uuid().parse(requestId):undefined;
  const sessionId=trustedSessionId===undefined?undefined:id.parse(trustedSessionId);
  return db.transaction(async tx=>{
    const [account]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,userId)).limit(1).for('update');
    if(!account||account.status!=='active'||!account.emailVerifiedAt){
      throw new Error('Verified user required for onboarding');
    }
    // Must revalidate the same session *inside* the state transaction:
    // a token verified before revocation cannot update preferences after it.
    await assertActiveTrustedSession(tx,userId,sessionId);
    await tx.insert(schema.userOnboarding).values({userId}).onConflictDoNothing();
    const [current]=await tx.select().from(schema.userOnboarding)
      .where(eq(schema.userOnboarding.userId,userId)).limit(1).for('update');
    if(!current)throw new Error('Onboarding row initialization failed');
    if(current.version!==input.expectedVersion){
      throw new Error('Onboarding version conflict: reload current state');
    }
    const currentIndex=stages.indexOf(current.stage as Stage);
    const targetIndex=stages.indexOf(input.stage);
    if(currentIndex===-1||targetIndex<currentIndex||targetIndex>currentIndex+1){
      throw new Error('Onboarding stage cannot skip or regress');
    }
    // The privacy notice has no legally approved, versioned acceptance
    // registry in V1 yet. A direct bearer, Web cookie or internal DB caller
    // must NOT reach "complete" just because the UI hides that action.
    // Keep previously persisted snapshots readable for migration; disallow
    // every new completion/update targeting that state until explicit,
    // server-verified privacy consent is added in a separately audited flow.
    if(input.stage==='complete'){
      throw new Error('Onboarding privacy consent acceptance is unavailable');
    }
    const [saved]=await tx.update(schema.userOnboarding).set({
      stage:input.stage,locale:input.locale,interests:input.interests,
      version:current.version+1,updatedAt:new Date(),
    }).where(eq(schema.userOnboarding.userId,userId)).returning();
    if(!saved)throw new Error('Onboarding update failed');
    await tx.insert(schema.auditEvents).values({
      actorId:userId,action:'user.onboarding.update',
      ...(trustedRequestId?{requestId:trustedRequestId}:{}),
      entityType:'user_onboarding',entityId:userId,
      beforeJson:{stage:current.stage,version:current.version},
      afterJson:{stage:saved.stage,version:saved.version,locale:saved.locale,
        interestsCount:saved.interests.length},
    });
    return snapshot(userId,saved);
  });
}
