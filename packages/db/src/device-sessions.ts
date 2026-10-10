import {and,desc,eq,gt,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type Db=ReturnType<typeof createFolioDb>['db'];
const id=z.uuid();
const authRequired=()=>new Error('Verified session required');
const active=(row:typeof schema.userSessions.$inferSelect)=>
  !row.revokedAt&&row.expiresAt.getTime()>Date.now();

/**
 * Caller IDs MUST come from an authenticated DB-backed bearer principal.
 * Shared locks on account/current session prevent concurrent revocation
 * from yielding an inventory for a newly invalidated caller.
 */
export async function listVerifiedDeviceSessions(db:Db,rawUserId:string,rawSessionId:string){
  const userId=id.parse(rawUserId),currentSessionId=id.parse(rawSessionId);
  return db.transaction(async tx=>{
    const [owner]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,userId)).limit(1).for('share');
    if(!owner||owner.status!=='active'||!owner.emailVerifiedAt)throw authRequired();
    const [current]=await tx.select().from(schema.userSessions)
      .where(and(eq(schema.userSessions.id,currentSessionId),
        eq(schema.userSessions.userId,userId))).limit(1).for('share');
    if(!current||!active(current))throw authRequired();
    const rows=await tx.select({
      id:schema.userSessions.id,deviceLabel:schema.userSessions.deviceLabel,
      createdAt:schema.userSessions.createdAt,expiresAt:schema.userSessions.expiresAt,
    }).from(schema.userSessions).where(and(
      eq(schema.userSessions.userId,userId),
      isNull(schema.userSessions.revokedAt),
      gt(schema.userSessions.expiresAt,new Date()),
    )).orderBy(desc(schema.userSessions.createdAt),desc(schema.userSessions.id)).limit(100);
    return {items:rows.map(row=>({
      id:row.id,deviceLabel:row.deviceLabel,
      createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),
      isCurrent:row.id===currentSessionId,
    }))};
  });
}

/**
 * Owner-only revocation, account-first lock ordering consistent with signin.
 * A foreign or missing UUID has the same result; an already-revoked owned
 * session is idempotently accepted without another audit event.
 */
export async function revokeVerifiedDeviceSession(
  db:Db,rawUserId:string,rawCallerId:string,rawTargetId:string,requestId?:string,
){
  const userId=id.parse(rawUserId),callerId=id.parse(rawCallerId),targetId=id.parse(rawTargetId);
  const auditRequestId=requestId===undefined?undefined:id.parse(requestId);
  return db.transaction(async tx=>{
    const [owner]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,userId)).limit(1).for('update');
    if(!owner||owner.status!=='active'||!owner.emailVerifiedAt)throw authRequired();
    const [caller]=await tx.select().from(schema.userSessions)
      .where(and(eq(schema.userSessions.id,callerId),
        eq(schema.userSessions.userId,userId))).limit(1).for('update');
    if(!caller||!active(caller))throw authRequired();
    const [target]=await tx.select().from(schema.userSessions)
      .where(and(eq(schema.userSessions.id,targetId),
        eq(schema.userSessions.userId,userId))).limit(1).for('update');
    if(!target)return {found:false,revoked:false};
    if(target.revokedAt)return {found:true,revoked:false};
    await tx.update(schema.userSessions).set({revokedAt:new Date()})
      .where(and(eq(schema.userSessions.id,targetId),eq(schema.userSessions.userId,userId),
        isNull(schema.userSessions.revokedAt)));
    await tx.insert(schema.auditEvents).values({
      actorId:userId,action:'auth.session.revoked',
      entityType:'user_session',entityId:targetId,
      ...(auditRequestId?{requestId:auditRequestId}:{}),
      afterJson:{revoked:true,ownDevice:targetId===callerId},
    });
    return {found:true,revoked:true};
  });
}
