import {createHash,randomBytes} from 'node:crypto';
import {and,desc,eq,gt,or} from 'drizzle-orm';
import {z} from 'zod';
import {
  friendInviteCodeSchema,friendshipActionSchema,friendshipListSchema,
} from '@folio/contracts';
import type {FriendshipList} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import {withOwner} from './owned-shelf.js';
import * as schema from './schema.js';

type Database=ReturnType<typeof createFolioDb>['db'];
const uuid=z.uuid();
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sevenDays=7*24*60*60*1000;
const digest=(code:string)=>createHash('sha256').update(code,'ascii').digest('hex');

/** Minimal and intentional errors: private invite resolution never reveals account IDs. */
export class FriendInviteNotFound extends Error{
  constructor(){super('Invite unavailable');this.name='FriendInviteNotFound';}
}
export class FriendshipConflict extends Error{
  constructor(){super('Friendship already exists or is blocked');this.name='FriendshipConflict';}
}
export class FriendshipNotFound extends Error{
  constructor(){super('Friendship not found');this.name='FriendshipNotFound';}
}
export class FriendshipForbidden extends Error{
  constructor(){super('Only the recipient may respond');this.name='FriendshipForbidden';}
}
function code():string{
  const bytes=randomBytes(16);
  return Array.from(bytes,b=>alphabet[b&31]!).join('');
}
function pair(left:string,right:string):[string,string]{
  return left<right?[left,right]:[right,left];
}
function audit(actorId:string,action:string,entityId:string,state?:string){
  return {actorId,action,entityType:'friend_pairs',entityId,
    ...(state?{afterJson:{state}}:{})};
}

/** Explicit rotation: no GET endpoint exists that can expose a previously issued code. */
export async function rotateOwnedInvite(db:Database,userId:string,sessionId:string){
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const inviteCode=code();
    const expiresAt=new Date(Date.now()+sevenDays);
    await tx.insert(schema.friendInvites).values({
      ownerId:actor,codeHash:digest(inviteCode),expiresAt,
    }).onConflictDoUpdate({
      target:schema.friendInvites.ownerId,
      set:{codeHash:digest(inviteCode),expiresAt,createdAt:new Date()},
    });
    await tx.insert(schema.auditEvents).values({
      actorId:actor,action:'friend.invite.rotate',entityType:'user',entityId:actor,
    });
    return {code:inviteCode,expiresAt:expiresAt.toISOString()};
  });
}

/** Code redemption cannot enumerate people; both identities must be verified. */
export async function redeemOwnedInvite(
  db:Database,userId:string,sessionId:string,rawCode:unknown,
){
  const inviteCode=friendInviteCodeSchema.parse(rawCode);
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const [invite]=await tx.select().from(schema.friendInvites)
      .where(and(eq(schema.friendInvites.codeHash,digest(inviteCode)),
        gt(schema.friendInvites.expiresAt,new Date()))).limit(1);
    if(!invite||invite.ownerId===actor)throw new FriendInviteNotFound();
    const [account]=await tx.select().from(schema.userAccounts).where(
      eq(schema.userAccounts.id,invite.ownerId)).limit(1).for('share');
    if(!account||account.status!=='active'||!account.emailVerifiedAt){
      throw new FriendInviteNotFound();
    }
    const [lowerUserId,higherUserId]=pair(actor,invite.ownerId);
    const [created]=await tx.insert(schema.friendPairs).values({
      lowerUserId,higherUserId,requestedById:actor,status:'pending',
    }).onConflictDoNothing({target:[
      schema.friendPairs.lowerUserId,schema.friendPairs.higherUserId,
    ]}).returning();
    if(!created)throw new FriendshipConflict();
    await tx.insert(schema.auditEvents).values(audit(actor,'friend.request',created.id,'pending'));
    return {requestId:created.id,state:'pending' as const};
  });
}

/** Recipient accepts/rejects; either participant may block. No listing by user ID. */
export async function decideOwnedFriendship(
  db:Database,userId:string,sessionId:string,raw:unknown,
){
  const input=friendshipActionSchema.parse(raw);
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const [existing]=await tx.select().from(schema.friendPairs).where(and(
      eq(schema.friendPairs.id,input.requestId),
      or(eq(schema.friendPairs.lowerUserId,actor),eq(schema.friendPairs.higherUserId,actor)),
    )).limit(1).for('update');
    if(!existing||existing.status==='rejected'||existing.status==='blocked'){
      throw new FriendshipNotFound();
    }
    if(input.action==='accept'||input.action==='reject'){
      if(existing.status!=='pending')throw new FriendshipConflict();
      if(existing.requestedById===actor)throw new FriendshipForbidden();
    }
    const state=input.action==='accept'?'accepted':input.action==='reject'?'rejected':'blocked';
    await tx.update(schema.friendPairs).set({
      status:state,blockedById:state==='blocked'?actor:null,updatedAt:new Date(),
    }).where(eq(schema.friendPairs.id,existing.id));
    await tx.insert(schema.auditEvents).values(audit(actor,'friend.'+input.action,existing.id,state));
    return {state};
  });
}

/** A private list; an unaccepted invite never exposes another person's profile. */
export async function listOwnedFriendships(
  db:Database,userId:string,sessionId:string,
):Promise<FriendshipList>{
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const rows=await tx.select().from(schema.friendPairs).where(or(
      eq(schema.friendPairs.lowerUserId,actor),eq(schema.friendPairs.higherUserId,actor),
    )).orderBy(desc(schema.friendPairs.updatedAt)).limit(100);
    const items:FriendshipList['items']=[];
    for(const row of rows){
      if(row.status==='rejected'||(row.status==='blocked'&&row.blockedById!==actor)){
        continue;
      }
      const peer=row.lowerUserId===actor?row.higherUserId:row.lowerUserId;
      let displayName:string|null=null;
      if(row.status==='accepted'){
        const [profile]=await tx.select({
          name:schema.userOnboarding.displayName,visibility:schema.userOnboarding.visibility,
        }).from(schema.userOnboarding).where(eq(schema.userOnboarding.userId,peer)).limit(1);
        if(profile?.visibility==='friends'&&profile.name)displayName=profile.name;
      }
      items.push({
        requestId:row.id,
        direction:row.requestedById===actor?'outgoing':'incoming',
        state:row.status as 'pending'|'accepted'|'blocked',
        displayName,
      });
    }
    return friendshipListSchema.parse({items});
  });
}
