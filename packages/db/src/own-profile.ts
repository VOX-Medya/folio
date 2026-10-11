import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {ownProfileSchema,ownProfileUpdateSchema} from '@folio/contracts';
import type {OwnProfile} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {withOwner} from './owned-shelf.js';

type Db=ReturnType<typeof createFolioDb>['db'];
export class OwnProfileConflict extends Error{
  constructor(){super('Profile changed on another request');this.name='OwnProfileConflict';}
}
function snapshot(userId:string,row:typeof schema.userOnboarding.$inferSelect|undefined):OwnProfile{
  return ownProfileSchema.parse({
    userId,displayName:row?.displayName??'',locale:row?.locale??'tr',
    visibility:row?.visibility??'private',
    deletionRequestedAt:row?.deletionRequestedAt?.toISOString()??null,
    version:row?.version??0,
  });
}
export async function getOwnProfile(db:Db,rawUser:string,rawSession:string){
  return withOwner(db,rawUser,rawSession,async tx=>{
    const [row]=await tx.select().from(schema.userOnboarding).where(
      eq(schema.userOnboarding.userId,rawUser)).limit(1);
    return snapshot(rawUser,row);
  });
}
/** Profile and onboarding share locale/version in one row. */
export async function patchOwnProfile(
  db:Db,rawUser:string,rawSession:string,rawBody:unknown,requestId?:string,
){
  const input=ownProfileUpdateSchema.parse(rawBody);
  const trace=requestId?z.uuid().parse(requestId):undefined;
  return withOwner(db,rawUser,rawSession,async tx=>{
    await tx.insert(schema.userOnboarding).values({userId:rawUser}).onConflictDoNothing();
    const [current]=await tx.select().from(schema.userOnboarding).where(
      eq(schema.userOnboarding.userId,rawUser)).limit(1).for('update');
    if(!current)throw new Error('Profile missing');
    if(current.version!==input.expectedVersion)throw new OwnProfileConflict();
    const [updated]=await tx.update(schema.userOnboarding).set({
      displayName:input.displayName,locale:input.locale,visibility:input.visibility,
      version:current.version+1,updatedAt:new Date(),
    }).where(eq(schema.userOnboarding.userId,rawUser)).returning();
    if(!updated)throw new Error('Profile not saved');
    await tx.insert(schema.auditEvents).values({
      actorId:rawUser,action:'user.profile.update',
      ...(trace?{requestId:trace}:{}),
      entityType:'user_onboarding',entityId:rawUser,
      beforeJson:{version:current.version,visibility:current.visibility},
      afterJson:{version:updated.version,visibility:updated.visibility,
        locale:updated.locale,displayNameChanged:current.displayName!==updated.displayName},
    });
    return snapshot(rawUser,updated);
  });
}
/** Request-only, never an immediate irreversible account removal. */
export async function requestOwnAccountDeletion(
  db:Db,rawUser:string,rawSession:string,requestId?:string,
){
  const trace=requestId?z.uuid().parse(requestId):undefined;
  return withOwner(db,rawUser,rawSession,async tx=>{
    await tx.insert(schema.userOnboarding).values({userId:rawUser}).onConflictDoNothing();
    const [existing]=await tx.select().from(schema.userOnboarding).where(
      eq(schema.userOnboarding.userId,rawUser)).limit(1).for('update');
    if(!existing)throw new Error('Profile missing');
    if(!existing.deletionRequestedAt){
      await tx.update(schema.userOnboarding).set({
        deletionRequestedAt:new Date(),updatedAt:new Date(),
        version:existing.version+1,
      }).where(eq(schema.userOnboarding.userId,rawUser));
      await tx.insert(schema.auditEvents).values({
        actorId:rawUser,action:'user.account.deletion.requested',
        ...(trace?{requestId:trace}:{}),
        entityType:'user_onboarding',entityId:rawUser,
        afterJson:{requested:true},
      });
    }
    return {requested:true as const};
  });
}
