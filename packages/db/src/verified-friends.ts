import {createHash,randomBytes} from 'node:crypto';
import {and,desc,eq,or} from 'drizzle-orm';
import {z} from 'zod';
import {
  friendInviteCodeSchema,friendListSchema,friendOperationResultSchema,friendRequestInputSchema,
} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {withOwner} from './owned-shelf.js';

type Db=ReturnType<typeof createFolioDb>['db'];
const uuid=z.uuid();
type Failure='not-found'|'conflict';
export class FriendshipDenied extends Error{
  constructor(readonly kind:Failure){
    super('Friendship action not allowed');this.name='FriendshipDenied';
  }
}
function ordered(left:string,right:string){
  if(left===right)throw new FriendshipDenied('not-found');
  return left<right?{left,right}:{left:right,right:left};
}
function hashCode(code:string){return createHash('sha256').update(code,'ascii').digest('hex');}
function traceId(raw?:string){return raw?uuid.parse(raw):undefined;}

export async function rotateVerifiedFriendInvite(
  db:Db,userId:string,sessionId:string,requestId?:string,
){
  const trace=traceId(requestId);
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const code=randomBytes(24).toString('base64url');
    await tx.insert(schema.userFriendInvites).values({
      userId:actor,codeHash:hashCode(code),
    }).onConflictDoUpdate({
      target:schema.userFriendInvites.userId,
      set:{codeHash:hashCode(code),updatedAt:new Date()},
    });
    await tx.insert(schema.auditEvents).values({
      actorId:actor,action:'friend.invite.rotate',entityType:'user_friend_invites',
      entityId:actor,...(trace?{requestId:trace}:{}),
      afterJson:{rotated:true},
    });
    return friendInviteCodeSchema.parse({code});
  });
}

export async function listVerifiedFriendLinks(db:Db,userId:string,sessionId:string){
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const rows=await tx.select().from(schema.userFriendLinks).where(
      or(eq(schema.userFriendLinks.leftUserId,actor),eq(schema.userFriendLinks.rightUserId,actor)),
    ).orderBy(desc(schema.userFriendLinks.updatedAt)).limit(100);
    const items=rows.filter(row=>row.status!=='blocked'||row.blockedBy===actor)
      .map(row=>({
        peerId:row.leftUserId===actor?row.rightUserId:row.leftUserId,
        state:row.status==='blocked'?'blocked' as const:row.status==='accepted'?'accepted' as const
          :row.requestedBy===actor?'outgoing' as const:'incoming' as const,
      }));
    return friendListSchema.parse({items});
  });
}

export async function requestVerifiedFriendLink(
  db:Db,userId:string,sessionId:string,raw:unknown,requestId?:string,
){
  const input=friendRequestInputSchema.parse(raw),trace=traceId(requestId);
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const [invite]=await tx.select().from(schema.userFriendInvites)
      .where(eq(schema.userFriendInvites.codeHash,hashCode(input.code)))
      .limit(1).for('share');
    if(!invite||invite.userId===actor)throw new FriendshipDenied('not-found');
    const [target]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,invite.userId)).limit(1);
    if(!target||target.status!=='active'||!target.emailVerifiedAt){
      throw new FriendshipDenied('not-found');
    }
    const ids=ordered(actor,invite.userId);
    const inserted=await tx.insert(schema.userFriendLinks).values({
      leftUserId:ids.left,rightUserId:ids.right,requestedBy:actor,
    }).onConflictDoNothing().returning({left:schema.userFriendLinks.leftUserId});
    if(!inserted.length)throw new FriendshipDenied('conflict');
    await tx.insert(schema.auditEvents).values({
      actorId:actor,action:'friend.request',entityType:'user_friend_links',
      entityId:actor,...(trace?{requestId:trace}:{}),
      afterJson:{peerId:invite.userId,state:'pending'},
    });
    return friendOperationResultSchema.parse({state:'pending'});
  });
}

export async function acceptVerifiedFriendLink(
  db:Db,userId:string,sessionId:string,rawPeerId:unknown,requestId?:string,
){
  const peerId=uuid.parse(rawPeerId),trace=traceId(requestId);
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const ids=ordered(actor,peerId);
    const [relation]=await tx.select().from(schema.userFriendLinks)
      .where(and(eq(schema.userFriendLinks.leftUserId,ids.left),
        eq(schema.userFriendLinks.rightUserId,ids.right))).limit(1).for('update');
    if(!relation||relation.status!=='pending'||relation.requestedBy===actor){
      throw new FriendshipDenied('not-found');
    }
    await tx.update(schema.userFriendLinks).set({status:'accepted',updatedAt:new Date()})
      .where(and(eq(schema.userFriendLinks.leftUserId,ids.left),
        eq(schema.userFriendLinks.rightUserId,ids.right)));
    await tx.insert(schema.auditEvents).values({
      actorId:actor,action:'friend.accept',entityType:'user_friend_links',
      entityId:actor,...(trace?{requestId:trace}:{}),
      afterJson:{peerId,state:'accepted'},
    });
    return friendOperationResultSchema.parse({state:'accepted'});
  });
}

export async function blockVerifiedFriendLink(
  db:Db,userId:string,sessionId:string,rawPeerId:unknown,requestId?:string,
){
  const peerId=uuid.parse(rawPeerId),trace=traceId(requestId);
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const ids=ordered(actor,peerId);
    const [relation]=await tx.select().from(schema.userFriendLinks)
      .where(and(eq(schema.userFriendLinks.leftUserId,ids.left),
        eq(schema.userFriendLinks.rightUserId,ids.right))).limit(1).for('update');
    if(!relation||(relation.status==='blocked'&&relation.blockedBy!==actor)){
      throw new FriendshipDenied('not-found');
    }
    if(relation.status!=='blocked'){
      await tx.update(schema.userFriendLinks).set({
        status:'blocked',blockedBy:actor,updatedAt:new Date(),
      }).where(and(eq(schema.userFriendLinks.leftUserId,ids.left),
        eq(schema.userFriendLinks.rightUserId,ids.right)));
      await tx.insert(schema.auditEvents).values({
        actorId:actor,action:'friend.block',entityType:'user_friend_links',
        entityId:actor,...(trace?{requestId:trace}:{}),
        afterJson:{peerId,state:'blocked'},
      });
    }
    return friendOperationResultSchema.parse({state:'blocked'});
  });
}
